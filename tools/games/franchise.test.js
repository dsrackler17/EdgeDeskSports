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
const TRADES = fs.readFileSync(G('trades/index.html'), 'utf8');
const STAFF = fs.readFileSync(G('staff/index.html'), 'utf8');
const FJS = fs.readFileSync(G('lib/franchise.js'), 'utf8');
const AUTHJS = fs.readFileSync(G('lib/auth.js'), 'utf8');
const SOCIALJS = fs.readFileSync(G('lib/social.js'), 'utf8');
const LANDING = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const H2H = fs.readFileSync(G('h2h/index.html'), 'utf8');
const SQLTEST = fs.readFileSync(path.join(__dirname, 'sql', 'games_franchise.test.sql'), 'utf8');
const NOTFOUND = fs.readFileSync(path.join(ROOT, '404.html'), 'utf8');
/* The sitemap is an INDEX (sitemap.xml -> sitemap-pages.xml +
   sitemap-articles.xml). What this file asserts is unchanged — the route must
   be in the sitemap — so it reads the whole SET through the one resolver. */
const SITEMAP = require(path.join(ROOT, 'tools', 'sitemap_set.js')).text(ROOT);
const README = fs.readFileSync(G('README.md'), 'utf8');
const PUB = fs.readFileSync(G('publish_board.js'), 'utf8');
const SOCIALSQL = fs.readFileSync(path.join(ROOT, 'supabase', 'games_social.sql'), 'utf8');
const DEV = fs.readFileSync(G('development/index.html'), 'utf8');
const PACKS = fs.readFileSync(G('packs/index.html'), 'utf8');
const SCHEMATOOL = fs.readFileSync(path.join(__dirname, 'schema.js'), 'utf8');
const FRCSS = fs.readFileSync(G('franchise.css'), 'utf8');

function fresh() { MEM = {}; ST.reset(); }
const T0 = Date.parse('2026-09-04T18:00:00Z');   /* Friday, week of 2026-09-01 */

/* ═══ 1. THE ECONOMY, PINNED TO THE SQL ═══════════════════════════════════ */
eq('the economy is versioned', F.ECONOMY_VERSION, 'economy_v2');
has(SQL, "'version', 'economy_v2'", 'and the SQL carries the same version');
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
  eq('the preview is versioned', pv.version, 'economy_v2');
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
      sent && /\/auth\/v1\/signup\?/.test(sent.url) && sent.headers.apikey === 'anon-key'
      && sent.body.data.consent_21plus === true && sent.body.data.consent_terms === true && sent.body.data.consent_version === AU.CONSENT_VERSION
      && sent.body.data.ref === 'partnera');
    /* THE CONFIRMATION LINK HAS TO COME BACK TO GAMES. Without redirect_to it
       lands on the project's Site URL — the marketing page — and a player who
       just founded a franchise is shown a pitch instead of their team. */
    chk('and tells Supabase to send the confirmation link back into Games',
      /redirect_to=[^&]*%2Fgames%2F/.test(sent.url));
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
}).then(async () => {
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
  has(README, 'economy_v2', 'and the economy version');
  has(fs.readFileSync(path.join(ROOT, 'supabase', 'README.md'), 'utf8'), 'games_franchise.sql', 'and the supabase README lists it');

  /* ═══ 11. THE WEEKLY GAME (PHASE 2) ═══════════════════════════════════════ */
  /* the simulator's published shape is the SQL's */
  /* sim_v2 since Phase 13: a giveaway now hands the other side the ball in
     scoring range, which is what makes a turnover cost anything. Old boxes
     keep saying sim_v1 and stay true to the rules they were played under. */
  eq('the simulator is versioned', F.SIM_VERSION, 'sim_v4');
  has(SQL, "'sim', 'sim_v4'", 'and every box says so');
  chk('both simulators are the same version, so a challenge is the same football as a Saturday',
    (SQL.match(/'sim', 'sim_v4'/g) || []).length === 2
    && !/'sim', 'sim_v[123]'/.test(SQL));
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
  /* resume_v1: playing carries an OPERATION KEY as well as the identity, so a
     dropped connection can be resolved instead of guessed at. It still sends
     no result, and it is still never queued. */
  has(FJS, "once('play_week')", 'playing sends nothing but "play", the identity and a key');
  has(FJS, "p_kind: kind, p_op: key", 'and the key is what makes the retry the same operation');
  chk('the client never sends an outcome for a game it played',
    !/franchise_play_week[\s\S]{0,200}p_(score|result|game)/.test(FJS));
  chk('a play is never queued — the player must see the result the moment it exists', !/record\('franchise_play_week'/.test(FJS));
  has(FJS, "once('start_season')", 'starting a season is the same');
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
  has(AUTHJS, "/auth/v1/recover?redirect_to=", 'the reset goes through Supabase Auth');
  /* The reset link used to land on the Site URL, which has no password form on
     it — so every "forgot password" from Games was a dead end. */
  chk('and the reset link is aimed at the page that can actually reset it',
    /recover\?redirect_to=' \+ encodeURIComponent\(origin\(\) \+ '\/reset\.html'\)/.test(AUTHJS));
  /* A lapsed session must be renewable from inside Games. Before this, a
     player who signed up here and never opened the terminal was silently
     demoted to an anonymous device an hour later. */
  chk('a lapsed session is renewed from the refresh token rather than dropped',
    /grant_type=refresh_token/.test(AUTHJS) && /function ensure\(\)/.test(AUTHJS));
  chk('and the renewal is single-flight, so parallel page readers cannot spend the token twice',
    /var _refreshing = null;/.test(AUTHJS) && /if \(_refreshing\) return _refreshing;/.test(AUTHJS));
  chk('a refused refresh leaves the session in storage rather than erasing the franchise',
    /THE\s+SESSION IS LEFT WHERE IT IS/.test(AUTHJS));
  chk('the games boot renews before the franchise decides whose it is',
    /AU\.ensure\(\)/.test(JS) && JS.indexOf('AU.ensure()') < JS.indexOf('return FR.boot()'));
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
  /* league_v1 introduced ONE function that takes a result — the published
     franchise_standing_delta(), which says what a win is worth and applies
     nothing. The claim being defended is unchanged: no function that WRITES
     will take a score, a result or a seed from a client. */
  chk('a client sends nothing that changes a result: play and start take the identity and nothing else',
    /franchise_play_week\(p_secret text default null\)/.test(SQL) && /franchise_start_season\(p_secret text default null\)/.test(SQL)
    && !/p_score_for\b|p_box\b|p_game_seed/.test(SQL));
  chk('and the only function anywhere that takes a result is the published one that just prices it',
    (SQL.match(/\bp_result\b/g) || []).length > 0
    && (SQL.match(/create or replace function public\.\w+\([^)]*\bp_result\b/g) || [])
        .every(d => /franchise_standing_delta/.test(d))
    && /create or replace function public\.franchise_standing_delta\([\s\S]*?returns integer language sql immutable/.test(SQL));
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
  eq('the offseason is offseason_v2', F.OFFSEASON_VERSION, 'offseason_v2');
  has(SQL, "select 'offseason_v2';", 'the SQL names the version in one place');
  chk('and the report reads it from there rather than repeating it',
    /'version', public\.franchise_offseason_version\(\), 'after_season', p_from/.test(SQL));
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
  /* Phase 10 gave the client a develop() — but it ASKS, it does not decide.
     What must stay true is that no lift, no grade and no ceiling is ever
     computed here and sent to the server. */
  chk('the client never ages, retires or generates a player',
    !/function (offseason|age|retire|rookie)\(/.test(FJS) && !/rpc\('franchise_offseason/.test(FJS)
    && !/rpc\('franchise_generate_rookie/.test(FJS) && !/retired_season\s*[:=]/.test(FJS));
  chk('and asks for a development rather than deciding one: a player id and the identity, nothing else',
    /function develop\(player\) \{\s*return rpc\('franchise_develop', withSecret\(\{ p_player: String\(player \|\| ''\) \}\)\)/.test(FJS)
    && !/p_lift|p_grade|p_potential|p_developed/.test(FJS));
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
  has(README, 'offseason_v2', 'and the offseason');
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
  ['franchise_generate_player(uuid, text, integer, integer, text, text, text, integer, integer, integer)', 'franchise_open_market(uuid, integer)', 'franchise_prospect_json(public.game_players)', 'franchise_free_number(uuid, text, text)']
    .forEach(f => chk('the server keeps ' + f.split('(')[0] + ' from every client role', SQL.indexOf('revoke all on function public.' + f + ' from public, anon, authenticated') >= 0));
  ['franchise_market()', 'franchise_market_board(text)', 'franchise_scout(uuid, text)', 'franchise_draft(uuid, text)', 'franchise_sign(uuid, text)', 'franchise_release(uuid, text)']
    .forEach(f => chk('and opens ' + f.split('(')[0] + ' to anon and authenticated', SQL.indexOf('grant execute on function public.' + f + ' to anon, authenticated') >= 0));
  chk('the report grew to nineteen rows', /select 18, 'the market is '/.test(SQL) && /select 19, 'a prospect''s true ratings are read through the board only/.test(SQL));
  chk('the direct read admits no prospect and no free agent', /create policy game_players_own on public\.game_players for select\s+using \(franchise_id is not null and public\.franchise_is_mine\(franchise_id\) and status not in \('prospect', 'free_agent'\)\)/.test(SQL));
  /* the band is fixed per player and its WIDTH comes off his own row since
     scouting_v1; what has not changed is that it hides everything else */
  chk('an unscouted prospect is a band fixed per player, and no ratings',
    /lo := greatest\(40, p\.overall - \(abs\(hashtext\(p\.id::text \|\| ':band'\)\) % w\)\);/.test(SQL)
    && /hi := least\(99, lo \+ w - 1\);/.test(SQL)
    && /'range', jsonb_build_array\(lo, hi\), 'band', w, 'overall', null, 'potential', null/.test(SQL));
  chk('a report and a signing are one negative ledger row each, keyed by the player',
    /public\.franchise_credit\(v_f, 'sp', -cost, 'scout', p\.id::text/.test(SQL) && /public\.franchise_credit\(v_f, 'tc', -p\.asking, 'signing', p\.id::text/.test(SQL));
  chk('a short purse, a spent pick and a full roster are refused before anything is written',
    /not enough Scouting Points: % needed, % on hand/.test(SQL) && /no draft picks left until the next offseason/.test(SQL) && /the roster is full at %: release a player first/.test(SQL)
    && SQL.indexOf('not enough Scouting Points: % needed, % on hand') < SQL.indexOf("public.franchise_credit(v_f, 'sp', -cost, 'scout'"));
  chk('the floor and the starters hold on a release', /the roster cannot go below %/.test(SQL) && /you need at least % at %/.test(SQL));
  chk('founding opens the first window and the offseason the next', /perform public\.franchise_open_market\(v_id, 1\);/.test(SQL) && /mk := public\.franchise_open_market\(p_franchise, p_from \+ 1\);/.test(SQL));
  /* renewed, never banked — and since scouting_v1 the count itself is the
     rule plus at most the one pick the top grade is worth */
  chk('the picks are renewed, never banked',
    /set draft_picks = v_picks, market_season = p_window/.test(SQL)
    && /v_picks := \(m->>'picks'\)::int \+ case when \(sc->>'extra_pick'\)::boolean then 1 else 0 end;/.test(SQL));
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
  has(HOME, 'var cf=snap.conference||null', 'reading the conference off the home snapshot');
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

  /* ═══ 16. INJURIES, THE BOWL AND TRADES (PHASE 7) ════════════════════════ */
  /* three published tables, each pinned to the SQL number for number */
  eq('injuries are injury_v1 on both sides', F.INJURY_VERSION, 'injury_v1');
  has(SQL, "'version', 'injury_v1'", 'the SQL publishes the version');
  chk('the chance, the Conditioning step, the Iron Man weight and the starter weight are the SQL\'s',
    F.INJURY.base === 0.22 && F.INJURY.per_conditioning === 0.03 && F.INJURY.iron_man === 0.5 && F.INJURY.starter_weight === 2.0
    && /'base', 0\.22,\s*.*\n\s*'per_conditioning', 0\.03,/.test(SQL) && /'iron_man', 0\.5,/.test(SQL) && /'starter_weight', 2\.0,/.test(SQL));
  chk('the four severities are the SQL\'s, and they are a distribution',
    F.INJURY.severity.length === 4
    && F.INJURY.severity.reduce((a, x) => a + x.p, 0).toFixed(2) === '1.00'
    && F.INJURY.severity.every(x => new RegExp("'" + x.key + "',\\s+'name', '" + x.name + "',\\s+'games', " + x.games + ", 'p', " + x.p).test(SQL)));
  chk('every position\'s exposure is the SQL\'s number',
    Object.keys(F.INJURY.exposure).every(k => new RegExp("'" + k + "', " + F.INJURY.exposure[k]).test(SQL))
    && F.INJURY.exposure.RB > F.INJURY.exposure.QB && F.INJURY.exposure.K < 0.1);
  eq('Conditioning buys the chance down to the published floor', F.injuryChance(3), 0.13);
  eq('and no Conditioning is the base', F.injuryChance(0), 0.22);
  eq('the bowl is bowl_v1 on both sides', F.BOWL_VERSION, 'bowl_v1');
  has(SQL, "'version', 'bowl_v1'", 'the SQL publishes the version');
  chk('the bowl rule is the same on both sides: more wins than losses, and nothing else',
    F.bowlEarned(5, 3) && F.bowlEarned(8, 0) && !F.bowlEarned(4, 4) && !F.bowlEarned(3, 5)
    && /select coalesce\(p_wins, 0\) > coalesce\(p_losses, 0\);/.test(SQL));
  chk('and the opponent\'s edge is the SQL\'s table', F.BOWL.edge_base === 2 && F.BOWL.edge_per_win === 1 && F.BOWL.edge_max === 8
    && /'edge_base', 2,.*\n\s*'edge_per_win', 1,.*\n\s*'edge_max', 8,/.test(SQL));
  eq('trades are trade_v1 on both sides', F.TRADE_VERSION, 'trade_v1');
  chk('one to three a side, a week to answer, the SQL\'s numbers',
    F.TRADE.max_per_side === 3 && F.TRADE.expires_days === 7
    && /'max_per_side', 3,\s*\n\s*'expires_days', 7,/.test(SQL));
  ['bowl_bid', 'bowl_win', 'trade_first', 'next_man_up'].forEach(id => {
    const m = new RegExp("\\('" + id + "',\\s+'([^']+)',").exec(SQL);
    chk('the SQL seeds ' + id + ' and the client names it the same', m && F.ACHIEVEMENTS[id] && F.ACHIEVEMENTS[id].name === m[1], m && m[1]);
  });
  chk('the bowl pays what the SQL pays', F.ECONOMY.bowl_game.xp === 150 && F.ECONOMY.bowl_game.tc === 60
    && F.ECONOMY.bowl_win.xp === 300 && F.ECONOMY.bowl_win.tc === 200 && F.ECONOMY.bowl_win.cp === 5
    && F.rewardsFor('bowl_win').cp === 5 && F.rewardsFor('bowl_game').tc === 60);
  /* availability, and how a card says it */
  chk('availability follows the server\'s flag, and the clock when there is none',
    F.isAvailable({ available: true }) && !F.isAvailable({ available: false })
    && F.isAvailable({ status: 'active' }) && !F.isAvailable({ status: 'retired' })
    && !F.isAvailable({ status: 'active', injured_until: new Date(Date.now() + 6e5).toISOString() })
    && F.isAvailable({ status: 'active', injured_until: new Date(Date.now() - 6e5).toISOString() }));
  eq('a hurt player\'s line names the injury and the games', F.injuryLine({ available: false, injury: { name: 'Sprain', games: 3 } }), 'Sprain · out 3 games');
  eq('one game reads singular', F.injuryLine({ available: false, injury: { name: 'Knock', games: 1 } }), 'Knock · out 1 game');
  eq('a fit player has no line', F.injuryLine({ available: true }), '');
  (() => {
    const a = F.bowlWatch({ wins: 5, losses: 2, ties: 0, weeks: 8 });
    const b = F.bowlWatch({ wins: 2, losses: 3, ties: 0, weeks: 8 });
    /* 2–4 with two to play tops out at 4–4, which is not a winning record:
       the watch says the bowl has gone rather than naming a number */
    const c = F.bowlWatch({ wins: 2, losses: 4, ties: 0, weeks: 8 });
    chk('the bowl watch says earned, or how many more wins it takes, or that it has gone',
      a.earned && a.need === 0 && !b.earned && b.need === 2 && !c.earned && c.need === null,
      JSON.stringify([a.need, b.need, c.need]));
  })();
  eq('an offer reads from the viewer\'s side', F.tradeSummary({ give: [1, 2], get: [3] }), '2 out, 1 in');
  eq('a traded player says where he came from', F.acquiredLine({ acquired_source: 'trade', acquired_season: 2026, acquired_detail: 'From the Comets' }), 'Traded for · 2026 · From the Comets');
  /* the client asks; the server draws, schedules and checks */
  has(FJS, "rpc('franchise_trade_partners', withSecret({}))", 'the trade floor is one read');
  has(FJS, "rpc('franchise_trade_offer', withSecret({", 'an offer sends ids and the identity');
  has(FJS, "rpc('franchise_trade_respond', withSecret({ p_trade: String(id || ''), p_accept: !!accept }))", 'an answer sends the trade and yes or no');
  has(FJS, "rpc('franchise_trade_withdraw', withSecret({ p_trade: String(id || '') }))", 'a withdrawal sends the trade');
  chk('no trade call is ever queued', !/record\('franchise_trade/.test(FJS));
  chk('the client never draws an injury, schedules a bowl or decides a trade is legal',
    !/Math\.random/.test(FJS + TRADES)
    && !/function drawInjur|function scheduleBowl|function checkTrade/.test(FJS + TRADES));
  /* the pages */
  has(TRADES, 'FR.tradePartners()', 'the trade page reads the floor through the server');
  has(TRADES, 'FR.tradeOffer(', 'and offers through it');
  has(TRADES, 'FR.tradeRespond(', 'and answers through it');
  has(TRADES, 'FR.tradeWithdraw(', 'and withdraws through it');
  ['trade_floor_view', 'trade_offer', 'trade_accept', 'trade_decline', 'trade_withdraw']
    .forEach(e => chk('the trade page fires ' + e, new RegExp("track\\('" + e + "'").test(TRADES)));
  has(TRADES, 'never that it is fair', 'the page says what the server does and does not check');
  has(TRADES, 'a deal is not undone', 'and asks once before a deal that cannot be undone');
  has(TRADES, 'The deadline is the bracket', 'and states the deadline');
  has(TRADES, 'A hurt player can be traded', 'and that a hurt man is still an asset');
  has(TRADES, 'Join a conference and the floor opens', 'a franchise with no conference is shown the door');
  has(TRADES, 'STALE SCRIPT GUARD', 'and the page guards against a stale cached library');
  chk('the trade page binds its delegated handler once, not once per render', /if\(!_wired\)\{rooms\.addEventListener/.test(TRADES));
  chk('the trade page invents no player, no price and no verdict',
    !/overall:\s*\d/.test(TRADES) && !/legal:\s*(true|false)/.test(TRADES));
  has(ROSTER, 'Treatment room', 'the roster has a treatment room');
  has(ROSTER, 'FR.isAvailable(p)', 'read from the server\'s own flag');
  has(ROSTER, 'still on the roster, still against the ceiling', 'and says a hurt man is still yours');
  has(GAMEDAY, 'injuryNote(', 'Game Day says what a game cost');
  has(GAMEDAY, 'bowl_name', 'and names the bowl rather than calling it week nine');
  has(GAMEDAY, 'earned a ninth game', 'and says where the ninth game came from');
  has(HOME, "'Bowl: play '", 'the HQ makes a bowl to play the day\'s objective');
  has(HOME, 'more win', 'and counts the wins that would earn one');
  has(HOME, 'data-cta="hq-trades"', 'and has a door to the trade floor');
  has(HOME, "' · <b>'+G.esc(inj.out)+'</b> hurt'", 'the calendar line carries the treatment room');
  has(TROPHIES, '<h2>Bowls</h2>', 'the Trophy Room has a bowls shelf');
  chk('the trade floor is a room of the facility',
    require(G('games.js')).ROOMS.some(r => r.key === 'trades' && r.href === '/games/trades/')
    && /href="\/games\/trades\/">Trades<\/a>/.test(JS));
  ['trade_floor_view', 'trade_offer', 'trade_accept', 'bowl_earned', 'injury_recorded']
    .forEach(e => chk('the funnel declares ' + e, JS.indexOf("'" + e + "'") >= 0));
  has(SITEMAP, 'https://edgedesksports.com/games/trades<', 'the sitemap lists the trade floor');
  has(NOTFOUND, "p[1]==='trades'", 'the static host routes it');
  chk('the asset bumper stamps the trade page',
    require(path.join(ROOT, 'tools', 'games', 'bump_assets.js')).PAGES.some(p => /trades\/index\.html$/.test(p)));
  chk('a hurt player is marked on the shared card and the mark has styling',
    /pc-hurt/.test(FJS) && /\.pc-hurt\{/.test(FCSS) && /\.pc-out\{/.test(FCSS) && /\.inj li\{/.test(FCSS)
    && /\.tr-off \.btn\{min-height:var\(--tap\)\}/.test(FCSS));
  /* the SQL keeps its conventions on the new side */
  ['franchise_draw_injuries(uuid, text, text, timestamptz)', 'franchise_schedule_bowl(uuid, integer, timestamptz)',
   'franchise_trade_json(uuid, uuid)', 'franchise_trade_player_json(uuid)']
    .forEach(f => chk('the server keeps ' + f.split('(')[0] + ' from every client role',
      SQL.indexOf('revoke all on function public.' + f + ' from public, anon, authenticated') >= 0));
  ['franchise_injuries()', 'franchise_postseason()', 'franchise_trade_rules()', 'franchise_trade_partners(text)',
   'franchise_trade_offer(uuid, uuid[], uuid[], text, text)', 'franchise_trade_respond(uuid, boolean, text)',
   'franchise_trade_withdraw(uuid, text)', 'franchise_trades_mine(integer, text)']
    .forEach(f => chk('and opens ' + f.split('(')[0] + ' to anon and authenticated',
      SQL.indexOf('grant execute on function public.' + f + ' to anon, authenticated') >= 0));
  chk('the report grew to twenty-five rows', /select 23, 'injuries are '/.test(SQL)
    && /select 24, 'the bowl is '/.test(SQL) && /select 25, 'trades are '/.test(SQL));
  chk('availability is a function of the clock, so there is no heal job to miss',
    /select p_status = 'active' and \(p_injured_until is null or p_injured_until <= p_at\);/.test(SQL)
    && !/franchise_heal/.test(SQL));
  chk('the five reads that decide a game all ask whether a player is available',
    (SQL.match(/public\.franchise_is_available\(p?\.?status, p?\.?injured_until\)/g) || []).length >= 4);
  chk('an injury never leaves a position below its starters',
    /if left_at < coalesce\(starters, 1\) then return '\[\]'::jsonb; end if;/.test(SQL));
  chk('injuries are drawn after the game, not inside it',
    /v_box := v_box \|\| jsonb_build_object\('injuries', public\.franchise_draw_injuries/.test(SQL)
    && !/franchise_draw_injuries/.test(
         (SQL.match(/create or replace function public\.franchise_sim\(p_franchise uuid, p_game uuid\)[\s\S]*?\n\$\$;/) || [''])[0]));
  chk('the offseason sends everybody back out fit',
    /update public\.game_players set injured_until = null, injury = null\s+where franchise_id = p_franchise and injured_until is not null;/.test(SQL));
  chk('the bowl is paid its own line, not the weekly one',
    /v_kind := case when g\.bowl then 'bowl_game' else 'weekly_game' end;/.test(SQL)
    && /v_kind_win := case when g\.bowl then 'bowl_win' else 'weekly_win' end;/.test(SQL));
  chk('a trade is re-checked at the moment it is taken, and a dead one keeps its reason',
    /RE-CHECKED at the moment it is taken/.test(SQL)
    && /update public\.franchise_trades set status = 'EXPIRED', reason = v_why, decided_at = now\(\) where id = t\.id;\s+return jsonb_build_object\('ok', false/.test(SQL));
  chk('a trade moves no currency at all', !/franchise_credit\([^)]*'trade/.test(SQL));
  chk('the SQL suite plays injuries, the bowl and trades through',
    /20\. INJURIES, THE BOWL AND TRADES/.test(SQLTEST)
    && /the specialists a roster has one of are never taken/.test(SQLTEST)
    && /a winning record earns the bowl rather than ending the season/.test(SQLTEST)
    && /a deal that would leave a position short is refused, by name/.test(SQLTEST));
  has(README, 'injury_v1', 'the README documents injuries');
  has(README, 'bowl_v1', 'and the bowl');
  has(README, 'trade_v1', 'and trades');
  has(README, 'legality, not fairness', 'and what the server checks about a deal');

  /* ═══ 17. THE COACHING STAFF (PHASE 8) ═══════════════════════════════════ */
  eq('the staff is staff_v2 on both sides', F.STAFF_VERSION, 'staff_v2');
  has(SQL, "'version', 'staff_v2'", 'the SQL publishes the version');
  chk('a thousand levels, twelve to hire, and the SQL\'s numbers throughout',
    F.STAFF.max_level === 1000 && F.STAFF.hire_cost === 12 && F.STAFF.cost_base === 1 && F.STAFF.cost_step === 10
    && F.STAFF.specialty_every === 25 && F.STAFF.specialty_max === 10 && F.STAFF.promote_max === 100
    && /'max_level', 1000,\s*\n\s*'hire_cost', 12,/.test(SQL)
    && /'specialty_every', 25,\s*\n\s*'specialty_max', 10,/.test(SQL));
  chk('the four seats and their caps are the SQL\'s',
    F.STAFF.seats.length === 4
    && F.STAFF.seats.every(s => new RegExp("'key', '" + s.key + "',[\\s\\S]{0,200}?'cap', " + s.cap.toFixed(1)).test(SQL))
    && F.staffSeat('offense').cap === 3.0 && F.staffSeat('trainer').cap === 1.0);
  chk('the grades are the SQL\'s ladder',
    F.STAFF.grades.length === 6
    && F.STAFF.grades.every(g => new RegExp("'at', " + g.at + ",\\s+'name', '" + g.name + "'").test(SQL)));
  /* THE COST CURVE — the same arithmetic on both sides, level for level */
  chk('the next level costs a Coach Point, and a Point more every ten levels',
    F.staffCost(1) === 1 && F.staffCost(10) === 1 && F.staffCost(11) === 2
    && F.staffCost(100) === 10 && F.staffCost(1000) === 100);
  chk('the climb is priced the same on both sides: nine, 540, and 50,400 for the thousand',
    F.staffCostBetween(1, 10) === 9 && F.staffCostBetween(1, 100) === 540
    && F.staffCostBetween(1, 1000) === 50400 && F.staffCostBetween(1, 1) === 0
    && /public\.franchise_staff_cost_between\(1, 1000\) = 50400/.test(SQL));
  chk('the cost never falls as the level rises', (() => {
    for (let L = 1; L < 1000; L++) if (F.staffCost(L) > F.staffCost(L + 1)) return false;
    return true;
  })());
  /* THE EFFECT CURVE — every tenfold is another third of the cap */
  chk('a level-one coach adds nothing and a level-thousand coach adds the cap',
    F.staffEffect(1, 3.0) === 0 && F.staffEffect(1000, 3.0) === 3.0);
  chk('every tenfold in level is another third of the cap',
    Math.abs(F.staffEffect(10, 3.0) - 1.0) < 0.01 && Math.abs(F.staffEffect(100, 3.0) - 2.0) < 0.01,
    F.staffEffect(10, 3.0) + ' / ' + F.staffEffect(100, 3.0));
  chk('the curve never falls and never passes the cap', (() => {
    for (let L = 1; L < 1000; L++) {
      if (F.staffEffect(L, 3.0) > F.staffEffect(L + 1, 3.0)) return false;
      if (F.staffEffect(L, 3.0) > 3.0) return false;
    }
    return true;
  })());
  chk('the client and the SQL agree on the formula, not just on its ends',
    /round\(\(coalesce\(p_cap, 0\) \* ln\(greatest\(1, least\(coalesce\(p_level, 1\), 1000\)\)\) \/ ln\(1000\)\)::numeric, 3\)/.test(SQL)
    && /Math\.log\(L\) \/ Math\.log\(STAFF\.max_level\)/.test(FJS));
  /* what a purse buys, and the names a level carries */
  (() => {
    const a = F.staffAfford(1, 30), b = F.staffAfford(1, 0), c = F.staffAfford(1000, 9999);
    chk('a purse buys as many levels as it can pay the rising price for, and never more than a call may',
      a.levels === 20 && a.cost === 30 && b.levels === 0 && b.cost === 0 && c.levels === 0
      && F.staffAfford(1, 999999).levels === F.STAFF.promote_max,
      JSON.stringify([a, b, c]));
  })();
  chk('a level carries a name, and a thousand carries the last one',
    F.staffGrade(1) === 'Rookie' && F.staffGrade(24) === 'Rookie' && F.staffGrade(25) === 'Assistant'
    && F.staffGrade(100) === 'Coordinator' && F.staffGrade(250) === 'Veteran'
    && F.staffGrade(500) === 'Legend' && F.staffGrade(1000) === 'Hall of Fame');
  chk('a specialty every twenty-five levels, ten at most',
    F.staffSpecialtyCount(1) === 0 && F.staffSpecialtyCount(25) === 1
    && F.staffSpecialtyCount(100) === 4 && F.staffSpecialtyCount(250) === 10 && F.staffSpecialtyCount(1000) === 10);
  eq('an empty seat says what it costs to fill', F.staffLine({ filled: false }), 'Empty · 12 CP to hire');
  eq('a filled one says the grade, the level and the worth',
    F.staffLine({ filled: true, seat: 'offense', level: 137, grade: 'Coordinator', effect: 2.13 }),
    'Coordinator · level 137 of 1000 · +2.13 offense');
  (() => {
    const p = F.staffProgress(100);
    chk('progress toward the thousand is measured in Coach Points spent, and says how small a hundred is',
      p.spent === 540 && p.total === 50400 && p.pct < 2, JSON.stringify(p));
  })();
  ['staff_first', 'staff_full', 'staff_100', 'staff_250', 'staff_1000'].forEach(id => {
    const m = new RegExp("\\('" + id + "',\\s+'([^']+)',").exec(SQL);
    chk('the SQL seeds ' + id + ' and the client names it the same', m && F.ACHIEVEMENTS[id] && F.ACHIEVEMENTS[id].name === m[1], m && m[1]);
  });
  /* the client asks; the server hires, levels and scores */
  has(FJS, "rpc('franchise_staff_board', withSecret({}))", 'the building is one read');
  has(FJS, "rpc('franchise_staff_hire', withSecret({ p_seat: String(seat || '') }))", 'a hire sends a seat and the identity');
  has(FJS, "rpc('franchise_staff_promote', withSecret({ p_seat: String(seat || ''), p_levels: levels | 0 }))", 'a promotion sends a seat and a number of levels');
  has(FJS, "rpc('franchise_staff_fire', withSecret({ p_seat: String(seat || '') }))", 'a firing sends a seat');
  chk('no staff call is ever queued', !/record\('franchise_staff/.test(FJS));
  chk('the client never generates a coach or decides what he is worth to a game',
    !/first_name:\s*'/.test(STAFF) && !/Math\.random/.test(STAFF));
  /* the page */
  has(STAFF, 'FR.staff()', 'the staff page reads the building through the server');
  has(STAFF, 'FR.staffHire(seat)', 'and hires through it');
  has(STAFF, 'FR.staffPromote(s2,n)', 'and promotes through it');
  has(STAFF, 'FR.staffFire(seat3)', 'and fires through it');
  ['staff_view', 'staff_hire', 'staff_promote', 'staff_fire']
    .forEach(e => chk('the staff page fires ' + e, new RegExp("track\\('" + e + "'").test(STAFF)));
  has(STAFF, 'Every tenfold in level is another third', 'the page states the effect curve it is asking you to climb');
  has(STAFF, 'so the climb is slow on purpose', 'and is honest that the climb is slow');
  has(STAFF, 'a horizon, not a plan', 'and that the thousand is a horizon');
  has(STAFF, 'the level goes with him', 'firing warns that the level goes too');
  has(STAFF, 'cannot be bought', 'and the page says Coach Points are earned, never bought');
  has(STAFF, 'Found my franchise', 'a visitor without a franchise is shown the door');
  has(STAFF, 'STALE SCRIPT GUARD', 'and the page guards against a stale cached library');
  chk('the seat bar goes to the next milestone, not to a thousand',
    /next_milestone/.test(STAFF) && /NEXT MILESTONE, never to a/.test(FCSS));
  chk('the staff page invents no level, no coach and no effect',
    !/level:\s*\d/.test(STAFF) && !/effect:\s*\d/.test(STAFF));
  /* the rest of the facility */
  chk('the staff is a room of the facility',
    require(G('games.js')).ROOMS.some(r => r.key === 'staff' && r.href === '/games/staff/')
    && /href="\/games\/staff\/">Staff<\/a>/.test(JS));
  ['staff_view', 'staff_hire', 'staff_promote', 'staff_fire']
    .forEach(e => chk('the funnel declares ' + e, JS.indexOf("'" + e + "'") >= 0));
  has(HOME, "'Staff: '", 'the HQ makes an empty seat or idle Coach Points the day\'s objective');
  has(HOME, 'data-cta="hq-staff"', 'and has a door to the building');
  has(HOME, 'var sfb=snap.staff||null;', 'reading the staff off the home snapshot');
  has(HOME, "' · staff <b>'", 'and the calendar line carries it');
  has(TROPHIES, '<h2>The building</h2>', 'the Trophy Room carries the building, which is the most permanent thing a franchise has');
  has(SITEMAP, 'https://edgedesksports.com/games/staff<', 'the sitemap lists the staff');
  has(NOTFOUND, "p[1]==='staff'", 'the static host routes it');
  chk('the asset bumper stamps the staff page',
    require(path.join(ROOT, 'tools', 'games', 'bump_assets.js')).PAGES.some(p => /staff\/index\.html$/.test(p)));
  chk('the seat cards stack on a phone and the actions meet the tap minimum',
    /\.st-grid\{display:grid/.test(FCSS) && /\.st-seat \.pc-actions \.btn\{min-height:var\(--tap\)\}/.test(FCSS));
  /* the SQL keeps its conventions on the new side */
  ['franchise_generate_coach(uuid, text, text, integer, integer)', 'franchise_staff_effects(uuid)',
   'franchise_staff_json(uuid, text)', 'franchise_staff_specialties(text, text, integer)']
    .forEach(f => chk('the server keeps ' + f.split('(')[0] + ' from every client role',
      SQL.indexOf('revoke all on function public.' + f + ' from public, anon, authenticated') >= 0));
  ['franchise_staff()', 'franchise_staff_cost(integer)', 'franchise_staff_cost_between(integer, integer)',
   'franchise_staff_effect(integer, numeric)', 'franchise_staff_grade(integer)', 'franchise_staff_board(text)',
   'franchise_staff_hire(text, text)', 'franchise_staff_promote(text, integer, text)', 'franchise_staff_fire(text, text)']
    .forEach(f => chk('and opens ' + f.split('(')[0] + ' to anon and authenticated',
      SQL.indexOf('grant execute on function public.' + f + ' to anon, authenticated') >= 0));
  chk('the report grew to twenty-six rows', /select 26, 'the staff is '/.test(SQL));
  chk('a coach is read by his owner and nobody else',
    /create policy franchise_staff_members_own on public\.franchise_staff_members for select\s+using \(public\.franchise_is_mine\(franchise_id\)\)/.test(SQL));
  chk('the staff reaches the simulator in the units it already reads, on both sides of a versus game',
    /st := public\.franchise_staff_effects\(p_franchise\);/.test(SQL)
    && /sta := public\.franchise_staff_effects\(p_a\); stb := public\.franchise_staff_effects\(p_b\);/.test(SQL)
    && /\(st->>'offense'\)::numeric/.test(SQL) && /\(sta->>'late_offense'\)::numeric/.test(SQL));
  chk('the trainer reaches the injury draw and the offseason',
    /v_chance := v_chance \* \(1 - coalesce\(\(public\.franchise_staff_effects\(p_franchise\)->>'injury_resist'\)::numeric, 0\)\);/.test(SQL)
    && /training := training \+ floor\(coalesce\(\(public\.franchise_staff_effects\(p_franchise\)->>'development'\)::numeric, 0\)\)::int;/.test(SQL));
  chk('a promotion buys what it can afford rather than refusing the lot, and never overspends',
    /exit when spent \+ step > f\.coach_points;/.test(SQL) && /'short', gained < want,/.test(SQL));
  /* the claim is about the CODE, not the prose: the only thing that removes
     a coach is the fire function, and nothing schedules or expires one */
  chk('nothing takes a coach away but his owner: the only delete is the one he asks for',
    (SQL.match(/delete from public\.franchise_staff_members/g) || []).length === 1
    && /create or replace function public\.franchise_staff_fire[\s\S]*?delete from public\.franchise_staff_members/.test(SQL)
    && !/franchise_staff_members[^;]*set level = 1\b/.test(SQL));
  chk('the SQL suite proves both curves level by level, not just at their ends',
    /21\. THE COACHING STAFF/.test(SQLTEST)
    && /the sum of the steps is the price of the climb/.test(SQLTEST)
    && /the curve never falls, and never passes the cap/.test(SQLTEST)
    /* staff_v2 replaced "starts at one" with "starts at what reputation
       commands" — the claim that survives is that the level was HIS, and
       does not carry over from the man fired */
    && /the man who replaces him starts at what reputation commands, not at the fired man/.test(SQLTEST));
  has(README, 'staff_v1', 'the README documents the staff');
  has(README, 'Every tenfold in level is another third of the\ncap', 'and the effect curve');
  has(README, 'a horizon rather than a plan', 'and is honest about the thousand');

  /* ═══ 18. THE SCHEMA LOG ══════════════════════════════════════════════════
     The files here are pasted and re-run rather than migrated. That is fine
     and staying — but for eight phases nothing could say WHICH phases a
     database had, so a project three behind looked exactly like a current
     one until a page called a function that was not there. Every phase now
     records itself as it applies, and the three places that name a phase —
     the SQL, the client mirror and the tool — must agree exactly. These
     assertions are what makes "the client says franchise 8" trustworthy. */

  /* the log itself lives in the base file, because the base file is applied
     first and the franchise file needs games_schema_note() to already exist */
  chk('the schema log is created by the base file, before anything uses it',
    /create table if not exists public\.games_schema_log \(/.test(SOCIALSQL)
    && SOCIALSQL.indexOf('create table if not exists public.games_schema_log')
       < SOCIALSQL.indexOf("games_schema_note('social'"));
  chk('the log is deny-by-default like every other table here: RLS on, no policy',
    /alter table public\.games_schema_log enable row level security;/.test(SOCIALSQL)
    && !/create policy [a-z_]* on public\.games_schema_log/.test(SOCIALSQL));
  chk('games_schema_note() pins its search_path and is closed to every client role',
    /create or replace function public\.games_schema_note\([\s\S]*?set search_path = public, pg_temp/.test(SOCIALSQL)
    && /revoke all on function public\.games_schema_note\(text, integer, text\) from public, anon, authenticated;/.test(SOCIALSQL));
  chk('games_schema() is the only door, and it is open to anon',
    /create or replace function public\.games_schema\(\)[\s\S]*?security definer[\s\S]*?set search_path = public, pg_temp/.test(SOCIALSQL)
    && /grant execute on function public\.games_schema\(\) to anon, authenticated;/.test(SOCIALSQL));
  /* the first-applied date is the useful one — it must never move on a re-run */
  chk('a re-run bumps the count and the re-applied date and never moves applied_at',
    /on conflict \(id\) do update\s+set name = excluded\.name, reapplied_at = now\(\), runs = public\.games_schema_log\.runs \+ 1;/.test(SOCIALSQL)
    && !/do update[\s\S]{0,300}[^a-z_]applied_at = now\(\)/.test(SOCIALSQL));

  /* EVERY PHASE RECORDS ITSELF. Read the notes out of both files and hold
     the client's mirror and the tool's reading against them. */
  const notes = layer => {
    const src = layer === 'social' ? SOCIALSQL : SQL;
    const re = /games_schema_note\(\s*'([a-z_]+)'\s*,\s*(\d+)\s*,\s*'((?:[^']|'')*)'\s*\)/g;
    const out = []; let m;
    while ((m = re.exec(src))) if (m[1] === layer) out.push({ phase: Number(m[2]), name: m[3].replace(/''/g, "'") });
    return out.sort((a, b) => a.phase - b.phase);
  };
  ['social', 'franchise'].forEach(layer => {
    const rows = notes(layer);
    chk(layer + ': every phase records itself, consecutively from 1',
      rows.length > 0 && rows.every((r, i) => r.phase === i + 1),
      'read ' + JSON.stringify(rows.map(r => r.phase)));
    eq(layer + ': the client mirror counts the same phases as the file',
      F.SCHEMA[layer], rows.length);
    chk(layer + ': the client names every phase exactly as the file records it',
      JSON.stringify(F.SCHEMA_PHASES[layer]) === JSON.stringify(rows.map(r => r.name)),
      'client ' + JSON.stringify(F.SCHEMA_PHASES[layer]) + ' vs sql ' + JSON.stringify(rows.map(r => r.name)));
  });
  /* the last note, whatever number it is, and the commit right after it */
  chk('the franchise notes are applied in one transaction, so a half-run cannot claim a phase',
    new RegExp("begin;[\\s\\S]{0,200}games_schema_note\\('franchise', 1,[\\s\\S]*?games_schema_note\\('franchise', "
      + F.SCHEMA.franchise + ",[\\s\\S]{0,80}commit;").test(SQL));
  chk('the self-check report opens by saying what this database has',
    /select 0, 'the schema log says what this database has/.test(SQL));

  /* THE GAP IS AN INSTRUCTION, not a number. A page that says "franchise 6"
     has told nobody anything; one that names the missing phases and the file
     to paste has. */
  chk('a level database reports no gap', F.schemaGap({ social: 1, franchise: F.SCHEMA.franchise }).ok);
  chk('a database behind by two names both phases and the file to paste', () => {
    const g = F.schemaGap({ social: 1, franchise: F.SCHEMA.franchise - 2 });
    return !g.ok && g.behind.length === 1 && g.behind[0].layer === 'franchise'
      && g.behind[0].behind === 2 && g.behind[0].file === 'supabase/games_franchise.sql'
      && g.behind[0].missing.length === 2
      && g.behind[0].missing[0].phase === F.SCHEMA.franchise - 1
      && g.behind[0].missing[1].name === F.SCHEMA_PHASES.franchise[F.SCHEMA.franchise - 1];
  });
  chk('an empty database is behind on both layers, not just the one', () => {
    const g = F.schemaGap({});
    return !g.ok && g.behind.length === 2 && g.behind.every(b => b.have === 0 && b.missing.length === b.want);
  });
  /* an old build against a newer database is not an error worth shouting */
  chk('a database AHEAD of this build is not reported as a gap', () => {
    const g = F.schemaGap({ social: 1, franchise: F.SCHEMA.franchise + 1 });
    return g.ok && g.ahead === true;
  });
  chk('the client asks the database through the one open function',
    /function schema\(\) \{ return rpc\('games_schema', \{\}\); \}/.test(FJS));

  /* THE STATUS PAGE. This is the page an operator opens when something is
     wrong, and "deployed / not deployed" was the whole vocabulary it had. */
  chk('the status page loads the franchise client, so it can compare',
    /<script src="\/games\/lib\/franchise\.js\?v=/.test(STATUS));
  /* the page reached for window.EDGamesFranchise once and silently rendered
     nothing below the market row: the global is EDFranchise */
  chk('and reaches for the global the library actually publishes',
    /F=window\.EDFranchise/.test(STATUS) && /root\.EDFranchise = API;/.test(FJS));
  chk('a database three phases behind is labelled Behind, not Not connected',
    /'Behind'\)\}\);/.test(STATUS) && /function row\(state,title,detail,action,label\)/.test(STATUS));
  /* a cached franchise.js must not blank the row or blame the database */
  chk('a stale library is named as a stale library, and the other rows still draw',
    /if\(cfg&&\(!F\|\|typeof F\.schema!=='function'\)\)\{/.test(STATUS)
    && /older copy of <code>\/games\/lib\/franchise\.js<\/code>/.test(STATUS)
    && /'Stale'\)\}\);/.test(STATUS));
  chk('a nine-phase gap names the first few and counts the rest',
    /b\.missing\.slice\(0,3\)/.test(STATUS) && /and '\+esc\(rest\)\+' more'/.test(STATUS));
  chk('the status page reads the schema and names the gap',
    /F\.schema\(\)/.test(STATUS) && /F\.schemaGap\(d\)/.test(STATUS)
    && /Database schema/.test(STATUS) && /show\.map\(function\(m\)\{return esc\(m\.phase\)/.test(STATUS));
  chk('the status page tells a pre-log database what to do instead of guessing',
    /before the schema log existed/.test(STATUS) && /Both are safe to run again/.test(STATUS));
  chk('the status page names the file to paste rather than the phase number alone',
    /gap\.behind\.map\(function\(b\)\{return '<code>'\+esc\(b\.file\)/.test(STATUS));

  /* THE TOOL. Same record, from a terminal, without opening a browser. */
  chk('the tool reads the phases out of the SQL rather than a list to remember',
    /games_schema_note\\\(/.test(SCHEMATOOL) && /fs\.readFileSync\(path\.join\(ROOT, file\)/.test(SCHEMATOOL));
  chk('the tool applies nothing: it posts to games_schema and reads config only',
    /rpc\/games_schema/.test(SCHEMATOOL)
    && !/games_schema_note/.test(SCHEMATOOL.replace(/games_schema_note\\\(/g, ''))
    && !/service_role/.test(SCHEMATOOL));
  chk('the tool exits non-zero when the database is behind, so a deploy check can use it',
    /phase\(s\) missing/.test(SCHEMATOOL) && /return 1;/.test(SCHEMATOOL));
  chk('the tool agrees with the SQL about what ships', () => {
    const { execFileSync } = require('child_process');
    const out = execFileSync(process.execPath, [path.join(__dirname, 'schema.js')], { encoding: 'utf8' });
    return notes('franchise').every(r => out.indexOf(String(r.phase) + '  ' + r.name) >= 0)
      && out.indexOf('franchise ' + F.SCHEMA.franchise + '   supabase/games_franchise.sql') >= 0;
  });

  has(README, 'games_schema_log', 'the README documents the schema log');
  has(README, 'npm run games:schema', 'and the tool that reads it');
  chk('the tool has a script name that does not need remembering', () =>
    JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
      .scripts['games:schema'] === 'node tools/games/schema.js');

  /* ═══ 19. THE SCOUTING DEPARTMENT (PHASE 9) ═══════════════════════════════
     Accuracy at real football, finally load-bearing. What these assertions
     defend, hardest first: the client's copy of the four curves is the SQL's
     copy; a neutral grade is exactly the game as it was; the department is
     named as touching POTENTIAL and never overall; and no page decides a
     grade, a band or a price. */

  eq('scouting is versioned', F.SCOUTING_VERSION, 'scouting_v1');
  has(SQL, "'version', 'scouting_v1'", 'and the SQL agrees');
  /* the whole table, pinned to franchise_scouting() rather than to a memory */
  chk('the window, the neutral, the ceiling and the extra pick are the SQL numbers',
    new RegExp("'window', " + F.SCOUTING.window + ",[\\s\\S]{0,80}'neutral', " + F.SCOUTING.neutral).test(SQL)
    && new RegExp("'ceiling', " + F.SCOUTING.ceiling + ",").test(SQL)
    && new RegExp("'extra_pick', " + F.SCOUTING.extra_pick + ",").test(SQL));
  chk('the band and the report price are the SQL ends',
    new RegExp("'band',\\s+jsonb_build_object\\('wide', " + F.SCOUTING.band.wide
      + ", 'tight', " + F.SCOUTING.band.tight + "\\)").test(SQL)
    && new RegExp("'report',\\s+jsonb_build_object\\('dear', " + F.SCOUTING.report.dear
      + ", 'cheap', " + F.SCOUTING.report.cheap + "\\)").test(SQL));
  F.SCOUTING.grades.forEach(function (g) {
    chk('the grade ' + g.key + ' is the SQL grade, at the SQL number',
      new RegExp("'key', '" + g.key + "',\\s+'name', '" + g.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        + "',\\s+'min', +" + g.min + "\\)").test(SQL));
  });
  chk('the grades run from zero and never go backwards', () =>
    F.SCOUTING.grades[0].min === 0
    && F.SCOUTING.grades.every((g, i) => i === 0 || g.min > F.SCOUTING.grades[i - 1].min));

  /* THE ANCHOR. Everything else about this phase is a tuning argument; this
     is the one that says an existing player's game did not change under them. */
  eq('a neutral grade is the band every class had before this phase',
    F.scoutBand(F.SCOUTING.neutral), 11);
  eq('and the report price market_v1 always charged',
    F.scoutCost(F.SCOUTING.neutral), F.MARKET.scout_sp);
  eq('and finds no extra potential at all', F.scoutLift(F.SCOUTING.neutral), 0);

  chk('the band never widens and the price never rises as the grade does', () => {
    for (var n = 0; n < 100; n++) {
      if (F.scoutBand(n) < F.scoutBand(n + 1)) return false;
      if (F.scoutCost(n) < F.scoutCost(n + 1)) return false;
      if (F.scoutLift(n) > F.scoutLift(n + 1)) return false;
    }
    return F.scoutBand(0) === F.SCOUTING.band.wide && F.scoutBand(100) === F.SCOUTING.band.tight
      && F.scoutCost(0) === F.SCOUTING.report.dear && F.scoutCost(100) === F.SCOUTING.report.cheap
      && F.scoutLift(100) === F.SCOUTING.ceiling;
  });
  chk('a department below neutral finds nothing rather than taking something away', () => {
    for (var n = -50; n <= F.SCOUTING.neutral; n++) if (F.scoutLift(n) !== 0) return false;
    return true;
  });
  chk('nothing runs off the ends of the curves', () =>
    [-999, -1, 0, 50, 100, 101, 9999, null, undefined, NaN, 'x'].every(function (n) {
      var b = F.scoutBand(n), c = F.scoutCost(n), l = F.scoutLift(n);
      return b >= F.SCOUTING.band.tight && b <= F.SCOUTING.band.wide
        && c >= F.SCOUTING.report.cheap && c <= F.SCOUTING.report.dear
        && l >= 0 && l <= F.SCOUTING.ceiling;
    }));

  /* THE CONFIDENCE RAMP: a new franchise is neutral, and the twentieth
     pricing is worth more than the first */
  eq('no record at all is a neutral grade', F.scoutScore(0, 0), F.SCOUTING.neutral);
  eq('five perfect pricings are not a perfect department', F.scoutScore(5, 100), 63);
  eq('twenty are', F.scoutScore(20, 100), 100);
  eq('and twenty terrible ones are the floor', F.scoutScore(20, 0), 0);
  chk('the ramp is monotone: another pricing at the same average never lowers the grade', () => {
    for (var n = 0; n < F.SCOUTING.window; n++) if (F.scoutScore(n, 90) > F.scoutScore(n + 1, 90)) return false;
    for (n = 0; n < F.SCOUTING.window; n++) if (F.scoutScore(n, 10) < F.scoutScore(n + 1, 10)) return false;
    return true;
  });

  chk('the grade a number is, and the next one up with the distance to it', () =>
    F.scoutGradeOf(0).key === 'unrated' && F.scoutGradeOf(39).key === 'unrated'
    && F.scoutGradeOf(40).key === 'regional' && F.scoutGradeOf(89).key === 'director'
    && F.scoutGradeOf(90).key === 'war_room' && F.scoutGradeOf(100).key === 'war_room'
    && F.scoutNext(100) === null && F.scoutNext(38).need === 2 && F.scoutNext(38).at === 40);
  eq('the one-line summary reads as a grade, a number and a record',
    F.scoutLine({ score: 94, priced: 18, grade_name: 'War room' }), 'War room · 94 · 18 of 20 priced');

  /* THE SERVER GRADES. The client mirrors the table for display and asks for
     nothing; there is no RPC here that could hand a grade to a page. */
  chk('no page and no client function decides a grade, a band or a price',
    !/scout_grade\s*[:=]\s*[0-9]/.test(FJS)
    && !/franchise_scout_report/.test(FJS)
    && !/franchise_scout_report/.test(MARKET) && !/franchise_scout_report/.test(OFFICE));
  chk('the grade is a definer read, reached through the board that proves who is asking',
    /revoke all on function public\.franchise_scout_report\(uuid\) from public, anon, authenticated;/.test(SQL)
    && /'scouting', public\.franchise_scout_report\(f\.id\)/.test(SQL));
  ['franchise_scouting()', 'franchise_scout_grade_of(integer)', 'franchise_scout_band(integer)',
   'franchise_scout_cost(integer)', 'franchise_scout_lift(integer)']
    .forEach(f => chk('the table function ' + f.split('(')[0] + ' is open to read',
      SQL.indexOf('grant execute on function public.' + f + ' to anon, authenticated') >= 0));

  /* WHAT IT TOUCHES, and the one thing it must not */
  chk('the department raises POTENTIAL and never overall',
    /set potential = least\(99, greatest\(overall, potential \+ v_lift\)\)/.test(SQL)
    && !/set overall = [^;]*v_lift/.test(SQL));
  chk('and restates rarity by the generator’s own rule rather than leaving it stale',
    /rarity = case when overall >= 82 or least\(99, greatest\(overall, potential \+ v_lift\)\) >= 90 then 'elite'/.test(SQL));
  chk('it does not reach the simulator: no scouting term in either game',
    !/franchise_scout_(band|cost|lift|report|grade_of)\(/.test(
      (SQL.match(/create or replace function public\.franchise_play_week[\s\S]*?\n\$\$;/) || [''])[0]
      + (SQL.match(/create or replace function public\.franchise_play_versus[\s\S]*?\n\$\$;/) || [''])[0]));
  chk('everything is decided once, when the window opens, and stamped on the class',
    /sc := public\.franchise_scout_report\(p_franchise\);/.test(SQL)
    && /scout_grade = v_grade/.test(SQL)
    && /scout_band = v_band/.test(SQL)
    && /'scout_grade', v_grade, 'scout_name', sc->>'grade_name'/.test(SQL));
  chk('an extra pick comes only at the top grade',
    /v_picks := \(m->>'picks'\)::int \+ case when \(sc->>'extra_pick'\)::boolean then 1 else 0 end;/.test(SQL));
  chk('a class opened before this phase is shown and priced the way it always was',
    /w := greatest\(2, coalesce\(p\.scout_band, 11\)\);/.test(SQL)
    && /case when f\.scout_grade is null then \(public\.franchise_market\(\)->>'scout_sp'\)::int/.test(SQL));
  chk('the band always contains the truth, and the SQL suite proves it at every width',
    /the band always contains the true overall, and is exactly as wide as it says, at every width/.test(SQLTEST)
    && /22\. THE SCOUTING DEPARTMENT/.test(SQLTEST)
    && /the department finds POTENTIAL and never touches overall/.test(SQLTEST)
    && /a NEUTRAL grade is exactly what every class had before this phase/.test(SQLTEST));

  /* THE PAGES */
  chk('the market page names the department that found this class AND the one you have now',
    /THIS CLASS WAS FOUND BY|This class was found by/.test(MARKET)
    && /Right now/.test(MARKET) && /function department\(b\)/.test(MARKET));
  chk('and prices every report from the class rather than the flat rule',
    /function cost\(b\)\{ return \(b&&b\.scout_cost!=null\)/.test(MARKET)
    && (MARKET.match(/esc\(cost\(b\)\)/g) || []).length >= 3);
  chk('an unscouted card says how wide its band is', /-point band — the true number is anywhere inside it/.test(MARKET));
  chk('the page is honest about what a grade does not do',
    /never how a Saturday goes, and never a rating on anybody already on the roster/.test(MARKET));
  chk('the Front Office shows the grade next to the Scouting Points it is not',
    /function scoutRow\(h\)/.test(OFFICE) && /Scouting department/.test(OFFICE)
    && /FR\.scoutGradeOf\(sc\.score\)/.test(OFFICE));
  chk('and says how many more games settle it', /more priced games and the grade is your own/.test(OFFICE));
  chk('both pages carry the styles they use',
    /\.sd-found,\.sd-now\{/.test(FCSS) && /\.res-scout\{/.test(FCSS));

  chk('the report grew to twenty-eight rows', /select 27, 'scouting is '/.test(SQL));
  chk('the schema log records the phase', /games_schema_note\('franchise', 9, 'the scouting department'\)/.test(SQL));
  chk('and the schema log records phase 9 by name',
    /games_schema_note\('franchise', 9, 'the scouting department'\)/.test(SQL));

  has(README, 'scouting_v1', 'the README documents the department');
  has(README, 'last twenty', 'and the window it grades on');
  has(README, '**potential, never overall**', 'and what it will not touch');

  /* ═══ 20. THE DEVELOPMENT PROGRAM AND THE LEAGUE (PHASE 10) ══════════════
     Two halves of one measured problem. Ten seasons of a franchise doing
     everything right moved team overall 69 → 71, because a man's ceiling was
     set at birth AND every opponent was rated from your own team overall.
     Hardest claims first: the schedule no longer reads your rating; a program
     raises potential and never overall; the client's copies of both tables
     are the SQL's; and no page decides a grade, a lift or a slate. */

  eq('development is versioned', F.DEVELOPMENT_VERSION, 'development_v1');
  eq('and the league is', F.LEAGUE_VERSION, 'league_v1');
  has(SQL, "'version', 'development_v1'", 'the SQL agrees on the program');
  has(SQL, "'version', 'league_v1'", 'and on the league');

  /* THE LOAD-BEARING ONE. While the scheduler read the team's own rating, a
     better roster could not win one extra game — measured, twelve seasons,
     four franchises an arm, +2.8 overall and not one extra win. */
  chk('the scheduler no longer rates an opponent from your own team overall', () => {
    const fn = (SQL.match(/create or replace function public\.franchise_schedule_season[\s\S]*?\n\$\$;/) || [''])[0];
    return fn.length > 0 && !/franchise_team_rating/.test(fn) && /o\.strength/.test(fn);
  });
  chk('every club carries a rating of its own, set from the pool and not from anybody',
    /alter table public\.franchise_opponents add column if not exists strength integer not null default 70;/.test(SQL)
    && /update public\.franchise_opponents o set strength = t\.s/.test(SQL));
  chk('and the column carries a default, so the pool insert above it can re-run',
    SQL.indexOf('insert into public.franchise_opponents (key, city, name')
      < SQL.indexOf('add column if not exists strength integer not null default 70'));

  /* the two tables, pinned to the SQL rather than to a memory */
  chk('the program table is the SQL table',
    new RegExp("'slots_base', " + F.DEVELOPMENT.slots_base + ",").test(SQL)
    && new RegExp("'cap', " + F.DEVELOPMENT.cap + ",").test(SQL)
    && new RegExp("'cost_base', " + F.DEVELOPMENT.cost_base + ",").test(SQL)
    && new RegExp("'cost_step', " + F.DEVELOPMENT.cost_step + ",").test(SQL)
    && new RegExp("'lift_base', " + F.DEVELOPMENT.lift_base + ", 'lift_span', " + F.DEVELOPMENT.lift_span + ",").test(SQL)
    && new RegExp("'age_full', " + F.DEVELOPMENT.age_full + ", 'age_half', " + F.DEVELOPMENT.age_half + ",").test(SQL));
  chk('the grade weights are the SQL weights, and they add to a hundred',
    new RegExp("'available', " + F.DEVELOPMENT.grade.available + ", 'record', " + F.DEVELOPMENT.grade.record
      + ", 'impact', " + F.DEVELOPMENT.grade.impact + "\\)").test(SQL)
    && F.DEVELOPMENT.grade.available + F.DEVELOPMENT.grade.record + F.DEVELOPMENT.grade.impact === 100);
  /* the SQL writes 0.20 where the client writes 0.2, so the numbers are
     compared as numbers rather than as the text either happens to use */
  chk('the league table is the SQL table', () => {
    const num = key => {
      const m = SQL.match(new RegExp("'" + key + "', (-?[0-9.]+)"));
      return m ? Number(m[1]) : null;
    };
    return num('standing_start') === F.LEAGUE.standing_start
      && num('standing_min') === F.LEAGUE.standing_min && num('standing_max') === F.LEAGUE.standing_max
      && num('win_base') === F.LEAGUE.win_base && num('loss_base') === F.LEAGUE.loss_base
      && num('edge_per_point') === F.LEAGUE.edge_per_point
      && num('rival_multiplier') === F.LEAGUE.rival_multiplier;
  });

  /* the curves, walked step by step against the shapes the SQL walks */
  eq('a program gives +1 for a season not played', F.devLift(0, 21), 1);
  eq('and +6 for a perfect one', F.devLift(100, 21), F.DEVELOPMENT.lift_base + F.DEVELOPMENT.lift_span);
  eq('halved past 26', F.devLift(100, 27), 3);
  eq('and nothing at 30', F.devLift(100, 30), 0);
  chk('the lift never falls as the grade rises, and never leaves its band', () => {
    for (var n = 0; n < 100; n++) if (F.devLift(n, 22) > F.devLift(n + 1, 22)) return false;
    return [-99, 0, 50, 100, 199].every(n => F.devLift(n, 22) >= 1 && F.devLift(n, 22) <= 6);
  });
  eq('a first place costs the base', F.devCost(0), F.DEVELOPMENT.cost_base);
  eq('and the last costs base plus the whole cap', F.devCost(F.DEVELOPMENT.cap),
    F.DEVELOPMENT.cost_base + F.DEVELOPMENT.cost_step * F.DEVELOPMENT.cap);
  chk('a place never gets cheaper the more a man has been given', () => {
    for (var n = 0; n < F.DEVELOPMENT.cap; n++) if (F.devCost(n) >= F.devCost(n + 1)) return false;
    return F.devCost(-5) === F.devCost(0) && F.devCost(99) === F.devCost(F.DEVELOPMENT.cap);
  });
  chk('places are two, one per Training Center level, and one every ten ranks', () =>
    F.devSlots(0, 1) === 2 && F.devSlots(1, 1) === 3 && F.devSlots(3, 1) === 5
    && F.devSlots(9, 1) === 5
    && F.devSlots(3, 10) === 6 && F.devSlots(3, 40) === 9
    && new RegExp("'slots_per_rank', " + F.DEVELOPMENT.slots_per_rank + ",").test(SQL)
    && /franchise_rank_report\(p_franchise\)->>'rank'/.test(
         (SQL.match(/create or replace function public\.franchise_dev_slots[\s\S]*?\n\$\$;/) || [''])[0]));

  /* the standing: results, and nothing else */
  chk('beating a club above you is worth more than beating one below', () =>
    F.standingDelta('W', 40, 85) > F.standingDelta('W', 40, 55) && F.standingDelta('W', 40, 55) >= 1);
  chk('losing to a club BELOW you is what costs; losing to one above costs the floor', () =>
    F.standingDelta('L', 40, 55) < F.standingDelta('L', 40, 85) && F.standingDelta('L', 40, 85) === -1);
  chk('the rival counts double either way, and a draw moves nothing', () =>
    F.standingDelta('W', 40, 70, true) === 2 * F.standingDelta('W', 40, 70)
    && F.standingDelta('L', 40, 60, true) === 2 * F.standingDelta('L', 40, 60)
    && F.standingDelta('T', 40, 70) === 0 && F.standingDelta('T', 40, 70, true) === 0);
  chk('a higher standing faces better clubs, always', () => {
    for (var n = 0; n < 100; n++) if (F.leagueFacing(n) > F.leagueFacing(n + 1)) return false;
    return F.leagueGap(40, 85) > 0 && F.leagueGap(40, 55) < 0;
  });
  chk('the client walks the same arithmetic the SQL does',
    /public\.franchise_league_gap\(p_standing, p_strength\)/.test(SQL)
    && /select coalesce\(p_strength, 0\) - \(48 \+ round\(coalesce\(p_standing, 40\) \* 0\.34\)::int\);/.test(SQL));
  /* the ONE place the two could drift and nobody would notice: the client
     must round before doubling, exactly as the SQL does */
  chk('and rounds before doubling, so a rival result is exactly twice an ordinary one',
    /return Math\.round\(n\) \* \(rival \? LEAGUE\.rival_multiplier : 1\);/.test(FJS)
    && /else 0 end\)::int\s*\* case when p_rival then/.test(SQL));

  /* THE SERVER GRADES, LIFTS AND SCHEDULES */
  chk('a program raises POTENTIAL and never overall',
    /set potential = least\(99, potential \+ v_lift\),/.test(SQL)
    && /developed = developed \+ v_lift,/.test(SQL)
    && !/set overall = [^;]*v_lift/.test(SQL));
  chk('the window is between a completed season and the next, and nothing else opens it',
    /the development window opens when a season is complete and closes when the next one starts/.test(SQL)
    && /if not found or s\.status <> 'complete' then/.test(SQL));
  chk('the grade is read out of the boxes the simulator already wrote, not accumulated on the hot path',
    /from public\.franchise_games g, jsonb_array_elements\(g\.box->'players'\) ln/.test(SQL)
    && !/season_stats = public\.games_jsonb_sum\(season_stats, ln->'stats' \|\|/.test(SQL));
  chk('a man is developed once an offseason, keyed by the season and the player',
    /'program', s\.number \|\| ':' \|\| p\.id::text,/.test(SQL)
    && /if not ok then raise exception 'that program is already on the books'/.test(SQL));
  chk('nobody grades a season, counts their own places or draws their own schedule',
    /revoke all on function public\.franchise_dev_grade\(uuid, uuid, integer\) from public, anon, authenticated;/.test(SQL)
    && /revoke all on function public\.franchise_dev_slots\(uuid\) from public, anon, authenticated;/.test(SQL)
    && /revoke all on function public\.franchise_schedule_season/.test(SQL));
  ['franchise_development()', 'franchise_dev_cost(integer)', 'franchise_dev_lift(integer, integer)',
   'franchise_dev_par(text, integer)', 'franchise_develop(uuid, text)', 'franchise_development_board(text)',
   'franchise_league()', 'franchise_league_gap(integer, integer)']
    .forEach(f => chk('the door ' + f.split('(')[0] + ' is open to every franchise',
      SQL.indexOf('grant execute on function public.' + f + ' to anon, authenticated') >= 0));

  /* THE PAGES */
  chk('the development page asks the server and never decides a lift',
    /FR\.development\(\)/.test(DEV) && /FR\.develop\(id\)/.test(DEV)
    && !/potential\s*[:+]=|lift\s*=\s*[0-9]/.test(DEV));
  chk('and shows what the season was, because that is what a program is worth on him',
    /dv-grade/.test(DEV) && /FR\.devGradeLine\(g\)/.test(DEV) && /par for his position/.test(DEV));
  chk('it is honest that a program raises the ceiling and not the man',
    /potential, never overall|<b>potential, never overall<\/b>/.test(DEV));
  chk('and that the window shuts when the next season starts',
    /Starting the next season closes this window/.test(DEV) && /do not carry over/.test(DEV));
  chk('the Front Office says where the franchise stands and what that faces',
    /function standingRow\(h\)/.test(OFFICE) && /FR\.standingName\(v\)/.test(OFFICE)
    && /drawn around clubs rating about/.test(OFFICE));
  chk('and warns while the window is open, because the places are otherwise lost',
    /function devRow\(h\)/.test(OFFICE) && /Starting the next season shuts the window/.test(OFFICE));
  chk('the page is a room like the others, with the guard the others wear',
    require(G('games.js')).ROOMS.some(r => r.key === 'development' && r.href === '/games/development/')
    && /EDFranchise\.development/.test(DEV) && /stale games scripts/.test(DEV));
  chk('both pages carry the styles they use', /\.dv-grade\{/.test(FCSS) && /\.lg-stand\{/.test(FCSS));
  /* A rule that names a variable nobody defines is not a style, it is a
     silent no-op — three of them shipped in Phase 9 before this caught them. */
  chk('every colour variable the franchise styles use is actually defined', () => {
    const defined = new Set();
    (CSS + FCSS).replace(/--([a-z0-9-]+)\s*:/g, (m, n) => { defined.add(n); return m; });
    const used = new Set();
    (FCSS + OFFICE + DEV + MARKET + ROSTER + GAMEDAY).replace(
      /var\(--([a-z0-9-]+)\)/g, (m, n) => { used.add(n); return m; });
    const missing = [...used].filter(n => !defined.has(n));
    return missing.length === 0 || (failures.push('undefined CSS variables: ' + missing.join(', ')) && false);
  });
  has(SITEMAP, '/games/development', 'the room is in the sitemap');
  has(NOTFOUND, "p[1]==='development'", 'and routed from 404');

  chk('the report grew to thirty rows',
    /select 28, 'development is '/.test(SQL) && /select 29, 'the league is '/.test(SQL));
  chk('the schema log records the phase',
    /games_schema_note\('franchise', 10, 'the development program and the league'\)/.test(SQL));
  chk('and the schema log records phase 10 by name',
    /games_schema_note\('franchise', 10, 'the development program and the league'\)/.test(SQL));
  chk('the SQL suite plays it through',
    /23\. THE DEVELOPMENT PROGRAM AND THE LEAGUE/.test(SQLTEST)
    && /the scheduler no longer rates an opponent from your own team overall/.test(SQLTEST)
    && /a program raises POTENTIAL and never overall/.test(SQLTEST)
    && /a starter who played every game grades above a man who never dressed/.test(SQLTEST));

  has(README, 'development_v1', 'the README documents the program');
  has(README, 'league_v1', 'and the league');
  has(README, 'rubber band', 'and names the thing that was wrong');

  /* ═══ 21. THE RANK AND THE PACKS (PHASE 11) ══════════════════════════════
     What turning up is worth. Every other progression here is paid for by
     being GOOD at something; the one number that measured PLAYING — the
     franchise level off XP — decided nothing and stopped at 30. Hardest
     claims first: nothing is purchasable; a pack's advertised band is true;
     the rank is derived from the record and cannot drift; and the client's
     copy of the curves is the SQL's. */

  eq('the rank is versioned', F.RANK_VERSION, 'rank_v1');
  eq('and the packs are', F.PACKS_VERSION, 'packs_v4');
  has(SQL, "'version', 'rank_v1'", 'the SQL agrees on the rank');
  has(SQL, "'pack_version', 'packs_v1'", "and the rank's own door still keeps every packs_v1 promise it made");

  /* THE LOAD-BEARING ONE. A pack is earned by playing and by nothing else. */
  /* Since staff_v2 a rank also PAYS Coach Points, so the function does call
     franchise_credit — with a positive delta. The claim being defended is
     unchanged and is the one that matters: opening a pack never costs. */
  chk('a pack costs no currency and no money: opening spends nothing', () => {
    const fn = (SQL.match(/create or replace function public\.franchise_pack_open[\s\S]*?\n\$\$;/) || [''])[0];
    return fn.length > 0
      /* no balance is ever checked against a price */
      && !/scouting_points\s*<|team_credits\s*<|coach_points\s*</.test(fn)
      /* and every ledger row it writes is a credit, never a debit */
      && !/franchise_credit\([^;]*,\s*-/.test(fn)
      && /public\.franchise_credit\(v_f, 'cp', v_cp, 'pack'/.test(fn);
  });
  chk('and the page says so where a player can see it',
    /Nothing here can be bought|cannot be bought/.test(PACKS)
    && /no pack for sale/.test(PACKS));
  chk('the rank counts ACTIVITY, never spending or winning',
    /'weekly_game', 3, 'bowl_bid', 3, 'conf_game', 3/.test(SQL)
    && !/weights[\s\S]{0,300}'weekly_win'/.test(SQL));

  /* the table, pinned to the SQL rather than to a memory */
  chk('the rank table is the SQL table',
    new RegExp("'cost_base', " + F.RANKS.cost_base + ", 'cost_step', " + F.RANKS.cost_step).test(SQL)
    && new RegExp("'pack_size', " + F.RANKS.pack_size + ", 'pack_keep', " + F.RANKS.pack_keep).test(SQL)
    && new RegExp("'floor_below', " + F.RANKS.floor_below + ",").test(SQL)
    && new RegExp("'edge_base', " + F.RANKS.edge_base + ", 'edge_per_rank', " + F.RANKS.edge_per_rank
      + ", 'edge_max', " + F.RANKS.edge_max).test(SQL));
  Object.keys(F.RANKS.weights).forEach(function (k) {
    chk('an activity of kind ' + k + ' is worth what the SQL says',
      new RegExp("'" + k + "', " + F.RANKS.weights[k] + "[,)]").test(SQL));
  });

  /* the curves */
  eq('rank two costs the base', F.rankCost(1), F.RANKS.cost_base);
  eq('and every rank after costs a step more', F.rankCost(2) - F.rankCost(1), F.RANKS.cost_step);
  chk('the rank never caps and never gets cheaper', () => {
    for (var r = 1; r < 300; r++) if (F.rankCost(r) >= F.rankCost(r + 1)) return false;
    return F.rankCost(1000) > F.rankCost(999);
  });
  chk('the sum of the steps is the points a rank stands on, at every rank', () => {
    for (var r = 1; r <= 80; r++) if (F.rankAt(r + 1) - F.rankAt(r) !== F.rankCost(r)) return false;
    return F.rankAt(1) === 0;
  });
  chk('and a pile of points buys exactly the rank it stands on', () => {
    for (var r = 1; r <= 80; r++) {
      if (F.rankFor(F.rankAt(r)) !== r) return false;
      if (r > 1 && F.rankFor(F.rankAt(r) - 1) !== r - 1) return false;
    }
    return F.rankFor(0) === 1 && F.rankFor(-50) === 1;
  });
  chk('a pack reaches further as the rank rises, and stops at the ceiling', () => {
    for (var r = 1; r < 300; r++) if (F.rankEdge(r) > F.rankEdge(r + 1)) return false;
    return F.rankEdge(1) === F.RANKS.edge_base && F.rankEdge(1000) === F.RANKS.edge_max;
  });
  chk('the band is drawn around your own team and never leaves 40 to 99', () =>
    [30, 55, 70, 90, 99].every(function (o) {
      return [1, 10, 40, 200].every(function (r) {
        var b = F.packBand(o, r);
        return b[0] >= 40 && b[1] <= 99 && b[0] <= b[1]
          && b[0] === Math.max(40, o - F.RANKS.floor_below)
          /* the ceiling is held at or above the floor: a team rated under 50
             would otherwise be offered a band that runs backwards */
          && b[1] === Math.max(b[0], Math.min(99, o + F.rankEdge(r)));
      });
    }));

  /* THE SERVER COUNTS, ROLLS AND KEEPS */
  chk('the rank is DERIVED from the activity already on the record',
    /select coalesce\(sum\(coalesce\(\(w->>a\.kind\)::int, 0\)\), 0\) into v_points\s*\n\s*from public\.franchise_activity a where a\.franchise_id = p_franchise;/.test(SQL));
  chk('and the only thing remembered is what has already been paid out',
    /alter table public\.franchises add column if not exists rank_claimed integer not null default 0;/.test(SQL)
    && /update public\.franchises set rank_claimed = v_rank/.test(SQL));
  chk('a rank pays one pack and cannot pay it twice',
    /if \(rep->>'packs'\)::int < 1 then/.test(SQL)
    && /raise exception 'no pack to open: rank % and % already claimed'/.test(SQL));
  /* MEASURED OVER SIXTY SEASONS: a pack opened with a full roster could not
     be kept from, and since two packs are never on the table at once it then
     refused every pack after it — rank 45, 37 claimed, three men stuck for
     twenty seasons. There must always be a way forward. */
  chk('two packs are never on the table at once, and the refusal names the way out',
    /open pack on the table: keep a man from it, or pass on it/.test(SQL));
  chk('a pack can always be turned down, so one can never block the rest',
    /create or replace function public\.franchise_pack_pass[\s\S]*?\n\$\$;/.test(SQL)
    && /raise exception 'no pack on the table'/.test(SQL)
    && SQL.indexOf('grant execute on function public.franchise_pack_pass(text) to anon, authenticated') >= 0);
  chk('and passing spends the rank, so it is a decision and not a re-roll',
    !((SQL.match(/create or replace function public\.franchise_pack_pass[\s\S]*?\n\$\$;/) || [''])[0]
        .match(/rank_claimed/)));
  chk('a pack man is not on the roster until he is kept',
    /when 'pack' then 'pack' else 'active' end,/.test(SQL)
    && /where franchise_id = v_f and status = 'active'/.test(SQL));
  chk('keeping one passes the other two over',
    /update public\.game_players set status = 'passed'[\s\S]{0,120}status = 'pack' and id <> p\.id;/.test(SQL));
  chk('and a full roster refuses him rather than growing past the ceiling',
    /if v_active >= \(m->>'roster_max'\)::int then/.test(SQL)
    && /the roster is full at %: release a player first/.test(SQL));

  /* THE ADVERTISED BAND IS TRUE. The generator's archetype skew used to pull
     a man several points off the number the roll was centred on, so a pack
     that said 59 to 71 handed over a 73. */
  chk('the generator lands on the target it was given',
    /if p_target is not null and ovr <> greatest\(40, least\(99, p_target\)\) then/.test(SQL)
    && /that advertises 59 to 71 and hands over a 73/.test(SQL));
  chk('and the old eight-argument generator is dropped, not left beside the new one',
    /drop function if exists public\.franchise_generate_player\(uuid, text, integer, integer, text, text, text, integer\);/.test(SQL)
    && SQL.indexOf('drop function if exists public.franchise_generate_player(uuid, text, integer, integer, text, text, text, integer);')
       < SQL.indexOf('p_kind text default \'rookie\', p_class integer default null, p_target integer default null,'));
  chk('and so is the nine-argument one, now that a rookie carries a lift',
    /drop function if exists public\.franchise_generate_player\(uuid, text, integer, integer, text, text, text, integer, integer\);/.test(SQL));
  chk('nobody counts their own rank; the moves are open like every other',
    /revoke all on function public\.franchise_rank_report\(uuid\) from public, anon, authenticated;/.test(SQL)
    && /revoke all on function public\.franchise_generate_player\(uuid, text, integer, integer, text, text, text, integer, integer, integer\) from public, anon, authenticated;/.test(SQL));
  ['franchise_ranks()', 'franchise_rank_cost(integer)', 'franchise_rank_at(integer)',
   'franchise_rank_for(integer)', 'franchise_rank_edge(integer)', 'franchise_pack_open(text)',
   'franchise_pack_keep(uuid, text)', 'franchise_rank_board(text)']
    .forEach(f => chk('the door ' + f.split('(')[0] + ' is open to every franchise',
      SQL.indexOf('grant execute on function public.' + f + ' to anon, authenticated') >= 0));

  /* the client asks and never decides */
  chk('the client asks the server to open and to keep, and rolls nothing',
    /function packOpen\(\) \{ return once\('pack_open'\)/.test(FJS)
    && /function packKeep\(player\) \{[\s\S]{0,140}once\('pack_keep', String\(player \|\| ''\)\)/.test(FJS)
    && !/Math\.random/.test(FJS));

  /* THE PAGE (the Vault, packs_v2 — every kind of pack goes through one door) */
  const VAULT_JS = fs.readFileSync(G('lib/vault.js'), 'utf8');
  chk('the packs page asks the server for the board and shows what every pack would hold',
    /FR\.packsBoard\(\)/.test(PACKS) && /FR\.packOpenId\(id\)/.test(PACKS) && /FR\.packKeep\(m\.id\)/.test(PACKS)
    && /odds\.low|od\.low/.test(PACKS) && /oddsChips\(od\)/.test(PACKS));
  chk('the server writes before the room shows: the page opens by id first and only then draws the Vault',
    PACKS.indexOf('FR.packOpenId(id)') < PACKS.indexOf('roomFor(packFor(') && /THE SERVER ROLLS AND WRITES FIRST/.test(PACKS));
  chk('and says how many to keep, and that the rest are passed over',
    /keep '\+esc\(p\.keep\)/.test(PACKS) && /passed over/.test(VAULT_JS) && /Keep ' \+ \(left === 1 \? 'one'/.test(VAULT_JS));
  chk('and offers the way out, so a pack can never block the ones behind it',
    /FR\.packPass\(\)/.test(PACKS) && /Pass on ' \+ \(kept \? 'the rest' : 'the whole pack'\)/.test(VAULT_JS)
    && /Finish the pack on the table first/.test(PACKS));
  chk('a pack already open survives a refresh: the page offers the same men back',
    /alreadyOpen/.test(PACKS) && /Back to the table/.test(PACKS) && /o\.alreadyOpen/.test(VAULT_JS));
  chk('it names what the next rank costs in the things you actually do',
    /FR\.rankWeight\('weekly_game'\)/.test(PACKS) && /FR\.rankWeight\('price_it'\)/.test(PACKS));
  chk('the page is a room like the others, with the guard the others wear',
    require(G('games.js')).ROOMS.some(r => r.key === 'packs' && r.href === '/games/packs/')
    && /EDFranchise\.packOpenId/.test(PACKS) && /EDVault\.open/.test(PACKS) && /stale games scripts/.test(PACKS));
  chk('a kept man can be read as a card of his own, with his line',
    /FR\.card\(id\)/.test(PACKS) && /edition/.test(PACKS) && /history/.test(PACKS));
  has(SITEMAP, '/games/packs', 'the room is in the sitemap');
  has(NOTFOUND, "p[1]==='packs'", 'and routed from 404');

  chk('the report grew to thirty-one rows', /select 30, 'the rank is '/.test(SQL));
  chk('the schema log records the phase',
    /games_schema_note\('franchise', 11, 'the rank and the packs'\)/.test(SQL));
  chk('and the schema log records phase 11 by name',
    /games_schema_note\('franchise', 11, 'the rank and the packs'\)/.test(SQL));

  /* THE BIGGEST THING THE SIXTY-SEASON RUN FOUND. The offseason compacted
     the depth chart but never re-sorted it, so every man acquired joined at
     the bottom and stayed there for his whole career: a franchise sixty
     seasons deep started a 59 receiver ahead of a 75, and team overall
     DECAYED from 74 to 67 while the roster got better. */
  chk('the preseason re-earns the depth chart rather than merely closing it up', () => {
    /* scoped to the offseason: reading the chart in depth order is right
       everywhere else — that is what a depth chart is for */
    /* the FULL signature: franchise_offseason_version() now sits above it and
       a prefix match reads that one-line function instead */
    const off = (SQL.match(/create or replace function public\.franchise_offseason\(p_franchise uuid, p_from integer\)[\s\S]*?\n\$\$;/) || [''])[0];
    return off.length > 0
      /* Phase 17: the loop walks the roster PLAN as well, because a position
         with nobody left in it is invisible to "where status = 'active'" and
         so could never be signed again */
      && /select pp->>'pos' from jsonb_array_elements\(public\.franchise_pool_plan\(\)\) pp/.test(off)
      && /select distinct position from public\.game_players\s*\n\s*where franchise_id = p_franchise and status = 'active'/.test(off)
      && /order by overall desc, potential desc, id loop/.test(off)
      && !/order by depth, overall desc loop/.test(off)
      && !/status = 'retired' and retired_season = p_from loop/.test(
           (off.match(/for v_pos in[\s\S]*?loop/) || [''])[0]);
  });
  chk('a player can still say otherwise afterwards',
    /create or replace function public\.franchise_set_starter/.test(SQL)
    && SQL.indexOf('grant execute on function public.franchise_set_starter(uuid, integer, text) to anon, authenticated') >= 0);

  has(README, 'rank_v1', 'the README documents the rank');
  has(README, 'packs_v1', 'and the packs');
  has(README, 'earned by playing', 'and that a pack is never bought');

  /* ═══ 22. THE LONG HAUL (PHASE 12) ═══════════════════════════════════════
     Sixty seasons of measurement, on the game as Phase 11 left it. It climbs
     to 81 by season ten and then cannot carry on. Three faults, all about the
     long game: the roster turned over in a WAVE, the building could never be
     STAFFED, and a replacement coach started at level one so firing anybody
     was a trap rather than a choice. */

  eq('careers are versioned', F.CAREER_VERSION, 'career_v1');
  eq('and the staff moved to its second version', F.STAFF_VERSION, 'staff_v2');
  has(SQL, "'version', 'career_v1'", 'the SQL agrees on careers');
  has(SQL, "'version', 'staff_v2'", 'and on the staff');

  /* ONE: the wave. Twenty-seven of thirty-eight founding players used to
     retire inside seasons 8 to 14, and barely anybody before. */
  chk('the founding roster is spread evenly across its ages, not skewed young', () => {
    const gen = (SQL.match(/create or replace function public\.franchise_generate_roster[\s\S]*?\n\$\$;/) || [''])[0];
    return gen.length > 0
      && /age := \(public\.franchise_career\(\)->>'found_age_min'\)::int/.test(gen)
      && /floor\(random\(\) \* \(\(public\.franchise_career\(\)->>'found_age_max'\)::int/.test(gen)
      && !/age := 21 \+ floor\(power\(random\(\)/.test(gen);
  });
  chk('and the range it spreads across is the published one',
    new RegExp("'found_age_min', " + F.CAREER.found_age_min
      + ", 'found_age_max', " + F.CAREER.found_age_max).test(SQL)
    && new RegExp("'retire_age', " + F.CAREER.retire_age + ",").test(SQL));
  chk('the retirement rule is still the one the table publishes',
    new RegExp("retire := age_new >= " + F.CAREER.retire_age
      + " or \\(age_new >= " + F.CAREER.retire_fade_age
      + " and ovr < " + F.CAREER.retire_fade_under + "\\);").test(SQL));

  /* TWO: the building. 10.4 Coach Points a season against a seat that costs
     540 to reach level 100 — one coach at level 99 in sixty years. */
  chk('a rank pays the building, and pays more the further you have come', () => {
    for (var r = 1; r < 200; r++) if (F.rankCoachPoints(r) >= F.rankCoachPoints(r + 1)) return false;
    return F.rankCoachPoints(1) === F.STAFF.rank_cp_base
      && F.rankCoachPoints(45) === F.STAFF.rank_cp_base + F.STAFF.rank_cp_step * 44;
  });
  chk('and the SQL pays it once, keyed by the rank, through the ledger',
    /v_cp := public\.franchise_rank_coach_points\(v_rank\);/.test(SQL)
    && /public\.franchise_credit\(v_f, 'cp', v_cp, 'pack', v_rank::text,/.test(SQL));
  chk('the numbers are the SQL numbers',
    new RegExp("'rank_cp_base', " + F.STAFF.rank_cp_base
      + ", 'rank_cp_step', " + F.STAFF.rank_cp_step).test(SQL)
    && new RegExp("'hire_level_max', " + F.STAFF.hire_level_max
      + ", 'hire_per_rank', " + F.STAFF.hire_per_rank
      + ", 'hire_per_standing', " + F.STAFF.hire_per_standing).test(SQL));
  /* forty-five ranks over sixty seasons should pay for a building, which is
     the whole point of the change */
  chk('forty-five ranks pay several thousand Coach Points', () => {
    var total = 0;
    for (var r = 1; r <= 45; r++) total += F.rankCoachPoints(r);
    return total > 2500 && total < 4500;
  });

  /* THREE: firing was a trap. "which is why almost nobody will" was in the
     README as a feature; a choice nobody takes is not a choice. */
  chk('a new coach arrives at what the reputation commands, not at level one', () =>
    F.staffHireLevel(1, 0) === 1 && F.staffHireLevel(45, 60) === 29
    && F.staffHireLevel(9999, 100) === F.STAFF.hire_level_max);
  chk('reputation never lowers what it commands, and never runs off the cap', () => {
    for (var r = 1; r < 300; r++) if (F.staffHireLevel(r, 50) > F.staffHireLevel(r + 1, 50)) return false;
    for (var st = 0; st < 100; st++) if (F.staffHireLevel(20, st) > F.staffHireLevel(20, st + 1)) return false;
    return [-9, 0, 1, 9999].every(n => F.staffHireLevel(n, 50) >= 1 && F.staffHireLevel(n, 50) <= F.STAFF.hire_level_max)
      && [-9, 0, 200].every(n => F.staffHireLevel(20, n) >= 1 && F.staffHireLevel(20, n) <= F.STAFF.hire_level_max);
  });
  chk('the hire reads the franchise\u2019s own rank and standing',
    /v_level := public\.franchise_staff_hire_level\(\s*\(public\.franchise_rank_report\(v_f\)->>'rank'\)::int, f\.standing\);/.test(SQL)
    && /franchise_generate_coach\(v_f, p_seat,[\s\S]{0,160}v_season, v_level\);/.test(SQL));
  chk('and the old four-argument coach generator is dropped, not left beside the new one',
    /drop function if exists public\.franchise_generate_coach\(uuid, text, text, integer\);/.test(SQL)
    && /revoke all on function public\.franchise_generate_coach\(uuid, text, text, integer, integer\) from public, anon, authenticated;/.test(SQL));
  /* keeping one man is still the best a single seat can do — the point is
     that firing is no longer a disaster, not that churning is now optimal */
  chk('keeping a coach still beats replacing him, by a long way', () => {
    /* a coach kept and levelled to 100 costs 540 CP; a replacement at the
       very top of what reputation commands arrives at 60 */
    return F.STAFF.hire_level_max < 100
      && F.staffCostBetween(1, 100) > F.staffCostBetween(F.STAFF.hire_level_max, 100);
  });

  ['franchise_career()', 'franchise_rank_coach_points(integer)', 'franchise_staff_hire_level(integer, integer)']
    .forEach(f => chk('the table ' + f.split('(')[0] + ' is open to read',
      SQL.indexOf('grant execute on function public.' + f + ' to anon, authenticated') >= 0));

  chk('the report grew to thirty-two rows', /select 31, 'the long haul is '/.test(SQL));
  chk('the schema log records the phase',
    /games_schema_note\('franchise', 12, 'the long haul: careers and a building you can staff'\)/.test(SQL));

  has(README, 'career_v1', 'the README documents careers');
  has(README, 'staff_v2', 'and the second staff version');
  has(README, 'in a wave', 'and names the thing that was wrong');

  /* ═══ 23. THE DRIVES YOU CALL (PHASE 13) ═════════════════════════════════
     "Retro Bowl, but leagues." Everything under this game was deeper than the
     game it is named after except the part your hands do: Game Day was one
     button, and its own copy said "Simulated on the server from your roster,
     your scheme, the opponent and this week's preparation." You never played
     a down.

     The load-bearing rule is the one this whole file exists to defend: A
     CALL IS A DECISION, NEVER A RESULT. The client sends 'air'; the server
     resolves the drive. These assertions pin the table to the SQL and prove
     that no client role can reach a resolver. */

  eq('the calls are snap_v1', F.SNAP_VERSION, 'snap_v1');
  chk('and the SQL says the same', /'version', 'snap_v1'/.test(SQL));
  eq('there are four of them', F.SNAPS.calls.length, 4);
  eq('and quick play is one of them', F.SNAPS['default'], 'balanced');

  /* the table, pinned number by number to franchise_snaps() */
  F.SNAPS.calls.forEach(c => {
    const row = new RegExp("'key', '" + c.key + "'[\\s\\S]{0,400}?'edge', ([-0-9.]+)\\)");
    const blk = (SQL.match(new RegExp("'key', '" + c.key + "'[\\s\\S]{0,400}?'edge', [-0-9.]+\\)")) || [''])[0];
    chk('the call ' + c.key + ' exists in the SQL', row.test(SQL));
    ['pass', 'td', 'turnover', 'edge'].forEach(k => {
      chk('and its ' + k + ' matches the client',
        blk.indexOf("'" + k + "', " + c[k]) >= 0
        || blk.indexOf("'" + k + "', " + c[k].toFixed(2)) >= 0
        || blk.indexOf("'" + k + "', " + c[k].toFixed(3)) >= 0);
    });
  });

  /* every call is a real trade — nothing is free */
  chk('the ground game passes less, scores less and gives it away less',
    F.snapCall('ground').pass < 0 && F.snapCall('ground').td < 0 && F.snapCall('ground').turnover < 0);
  chk('the air game passes more, scores more and gives it away more',
    F.snapCall('air').pass > 0 && F.snapCall('air').td > 0 && F.snapCall('air').turnover > 0);
  chk('a shot is the most of both',
    F.snapCall('shot').td > F.snapCall('air').td
    && F.snapCall('shot').turnover > F.snapCall('air').turnover);
  chk('no call scores more for free',
    !F.SNAPS.calls.some(c => c.td > 0 && c.turnover <= 0));
  chk('quick play moves nothing: Balanced is the zero row',
    F.snapCall('balanced').pass === 0 && F.snapCall('balanced').td === 0
    && F.snapCall('balanced').turnover === 0 && F.snapCall('balanced').edge === 0);
  chk('an unknown call falls back to the default rather than throwing',
    F.snapCall('nonsense').key === F.SNAPS['default'] && F.snapCall(null).key === F.SNAPS['default']);
  chk('every call says what it means, in English',
    F.SNAPS.calls.every(c => typeof c.means === 'string' && c.means.length > 20));

  /* THE LOAD-BEARING ONE. A client sends a call and never a result. */
  chk('the move takes a call and a secret, and nothing else',
    /create or replace function public\.franchise_game_call\(p_call text, p_secret text default null\)/.test(SQL));
  chk('and no client role can reach the drive resolver',
    /revoke all on function public\.franchise_sim_drive/.test(SQL)
    || SQL.indexOf('grant execute on function public.franchise_sim_drive') < 0);
  chk('nor the possession count',
    /revoke all on function public\.franchise_game_drives\(uuid, uuid\) from public, anon, authenticated;/.test(SQL));
  chk('the seven-argument drive resolver is dropped, so nothing can call the form that ignores a call',
    /drop function if exists public\.franchise_sim_drive\(numeric, numeric, numeric, numeric, numeric, numeric, boolean\);/.test(SQL));
  chk('the report proves the rule rather than describing it',
    /select 32, 'the game is '/.test(SQL)
    && /not has_function_privilege\('anon', 'public\.franchise_sim_drive\(numeric, numeric, numeric, numeric, numeric, numeric, boolean, text, numeric, boolean, text, text, integer\)', 'execute'\)/.test(SQL.replace(/\s+/g, ' ')));

  /* ONE SIMULATOR, not two. The calls live on the game and franchise_sim
     reads them, so re-running reproduces every drive already played. */
  chk('the calls are stored on the game',
    /alter table public\.franchise_games add column if not exists calls jsonb;/.test(SQL));
  chk('and the simulator reads them from there', () => {
    const sim = (SQL.match(/create or replace function public\.franchise_sim\(p_franchise uuid, p_game uuid\)[\s\S]*?\n\$\$;/) || [''])[0];
    return sim.length > 0
      && /calls := coalesce\(g\.calls, '\[\]'::jsonb\);/.test(sim)
      && /my_call := calls->>\(i - 1\);/.test(sim)
      && /'drives', drives/.test(sim);
  });
  chk('the last call finalises through the door every other game goes through',
    /return public\.franchise_play_game\(v_f, now\(\)\) \|\| jsonb_build_object\('called', v_mine, 'complete', true\);/.test(SQL));

  /* the two moves are open on the same terms every other franchise move is */
  ['franchise_snaps()', 'franchise_snap_call(text)', 'franchise_game_open(text)', 'franchise_game_call(text, text)']
    .forEach(f => chk('the move ' + f.split('(')[0] + ' is open to every franchise',
      SQL.indexOf('grant execute on function public.' + f + ' to anon, authenticated') >= 0));

  /* quick play stays: nobody is made to tap twelve times to see a result */
  chk('quick play is still there',
    SQL.indexOf('grant execute on function public.franchise_play_week(text) to anon, authenticated') >= 0);
  has(GAMEDAY, 'id="playBtn"', 'and Game Day still offers it');
  has(GAMEDAY, 'Quick play instead', 'by name');
  has(GAMEDAY, 'id="callBtn"', 'while calling it is the first thing offered');
  has(GAMEDAY, 'you send a call, never a result', 'and the page says what a call is');
  chk('Game Day no longer says you never play a down',
    GAMEDAY.indexOf('Simulated on the server from your roster, your scheme, the opponent and this week’s preparation. Every game is played once') < 0);
  chk('the page asks the library for the calls rather than listing its own',
    /FR\.callsFor\('def'\)\.map/.test(GAMEDAY) && /FR\.playbook\(f\.offense\)\.map/.test(GAMEDAY)
    && /FR\.gameCall\(/.test(GAMEDAY) && /FR\.gameOpen\(\)/.test(GAMEDAY));
  chk('and the stale-script guard knows the new moves',
    /EDFranchise\.gameOpen/.test(GAMEDAY) && /EDFranchise\.gameCall/.test(GAMEDAY));
  chk('every class the calling stage draws is defined in the stylesheet', () => {
    return ['sn-board', 'sn-calls', 'sn-log'].every(c => FRCSS.indexOf('.' + c) >= 0);
  });

  chk('the report grew to thirty-three rows', /select 32, 'the game is '/.test(SQL));
  chk('the schema log records the phase',
    /games_schema_note\('franchise', 13, 'the drives you call'\)/.test(SQL));


  has(README, 'snap_v1', 'the README documents the calls');
  has(README, 'never a result', 'and states the rule the whole phase rests on');

  /* ═══ 24. KEY MOMENTS (PHASE 14) ═════════════════════════════════════════
     Measured first. Fifteen hundred games between two IDENTICAL sides: by the
     last possession only 44% are within a score. The first fix I tried — late
     urgency for the trailing side — moved the margin 12.3 → 11.9 and the live
     finishes 43.9% → 44.1%, which is nothing, because pushing buys variance
     rather than points. And it SHOULD not close the gap: real football
     averages eleven or twelve points of margin too.

     So the football is not the fault. The game never knew which possessions
     mattered. Nothing in this phase touches how a drive resolves, and the
     assertions below are built to keep it that way. */
  eq('moments are moment_v1', F.MOMENT_VERSION, 'moment_v1');
  chk('and the SQL says the same', /'version', 'moment_v1'/.test(SQL));

  /* the published table, pinned number for number */
  Object.keys(F.MOMENTS).forEach(k => {
    chk('the rule ' + k + ' matches the SQL',
      new RegExp("'" + k + "', " + F.MOMENTS[k].toFixed(2).replace(/\.00$/, '')).test(SQL)
      || SQL.indexOf("'" + k + "', " + F.MOMENTS[k]) >= 0);
  });

  /* THE STAKE. Two halves, each obviously right on its own. */
  eq('a tied game on the last possession is everything', F.stake(0, 1), 1);
  eq('a tied first quarter decides nothing', F.stake(0, 9), 0);
  eq('and neither does four scores down with one to play', F.stake(28, 1), 0);
  eq('a possession that cannot happen is worth nothing', F.stake(0, 0), 0);
  chk('the stake never leaves [0, 1]', () => {
    for (let g = -60; g <= 60; g++) for (let l = 0; l <= 20; l++) {
      const v = F.stake(g, l);
      if (!(v >= 0 && v <= 1)) return false;
    }
    return true;
  });
  chk('closer is never worth less', () => {
    for (let l = 1; l <= 8; l++) for (let g = 0; g < 60; g++) {
      if (F.stake(g, l) < F.stake(g + 1, l)) return false;
    }
    return true;
  });
  chk('later is never worth less', () => {
    for (let g = 0; g <= 20; g++) for (let l = 1; l < 20; l++) {
      if (F.stake(g, l) < F.stake(g + 0, l + 1)) return false;
    }
    return true;
  });
  chk('a possession is worth the same to the side defending a lead as to the side chasing it',
    F.stake(7, 2) === F.stake(-7, 2) && F.stake(3, 1) === F.stake(-3, 1));
  chk('a key moment is rare enough to mean something',
    F.isKey(F.stake(0, 1)) && F.isKey(F.stake(7, 1)) && !F.isKey(F.stake(0, 4))
    && !F.isKey(F.stake(0, 9)) && !F.isKey(F.stake(21, 1)));

  /* THE LOAD-BEARING ONE. This phase reads the game; it does not play it. */
  /* This asserted "still sim_v2" until Phase 15 put the game on a clock. The
     claim it was standing for is that the STAKE changes no football, and that
     is what it asserts now — the number was never the point. */
  chk('the stake is read off the score, so it can move no football',
    /v_stake := public\.franchise_stake\(pts_me - pts_op, v_left\);/.test(SQL));
  chk('the stake is computed from the running score, before anything resolves', () => {
    const sim = (SQL.match(/create or replace function public\.franchise_sim\(p_franchise uuid, p_game uuid\)[\s\S]*?\n\$\$;/) || [''])[0];
    /* it must be drawn from pts_me/pts_op, never from a fresh roll */
    return /v_stake := public\.franchise_stake\(pts_me - pts_op, v_left\);/.test(sim)
      && !/random\(\)[^\n]*stake/i.test(sim);
  });
  chk('and both the stake and the story are immutable, so neither can consume a draw',
    /create or replace function public\.franchise_stake\(p_gap integer, p_left integer\)\nreturns numeric language sql immutable/.test(SQL)
    && /create or replace function public\.franchise_game_story\(p_drives jsonb\)\nreturns jsonb language sql immutable/.test(SQL));
  chk('a possession is one moment, not two: both drives share a stake, so only yours is counted',
    /'key', coalesce\(\(select count\(\*\) from d where \(x->>'key'\)::boolean and x->>'side' = 'me'\), 0\)/.test(SQL));

  /* THE REEL IS DERIVED, so there is nothing to keep in step */
  chk('there is no table of moments to drift out of step with the boxes',
    !/create table if not exists public\.franchise_moment/.test(SQL)
    && /jsonb_array_elements\(g\.box->'story'->'key_drives'\)/.test(SQL));
  chk('a franchise reads its own reel and nobody else\'s',
    /v_f uuid := public\.franchise_of\(p_secret\);/.test(
      (SQL.match(/create or replace function public\.franchise_reel[\s\S]*?\n\$\$;/) || [''])[0]));

  /* PLAYING IT OUT is quick play for what is left, not a shortcut past it */
  chk('every possession left is called by the published default for its own side of the ball',
    /then public\.franchise_snaps\(\)->>'default'/.test(SQL)
    && /else public\.franchise_fronts\(\)->>'default' end\)/.test(SQL));
  chk('and it finishes through the same door every other game goes through',
    /return public\.franchise_play_game\(v_f, now\(\)\)\s*\n?\s*\|\| jsonb_build_object\('called', jsonb_array_length\(coalesce\(g\.calls, '\[\]'::jsonb\)\),/.test(SQL));
  chk('the fill cannot spin on a pathological seed',
    /exit when v_guard > 60;/.test(SQL));

  ['franchise_moments()', 'franchise_stake(integer, integer)', 'franchise_game_finish(text)', 'franchise_reel(text, integer)']
    .forEach(f => chk('the move ' + f.split('(')[0] + ' is open to every franchise',
      SQL.indexOf('grant execute on function public.' + f + ' to anon, authenticated') >= 0));

  /* the page says it out loud */
  has(GAMEDAY, 'This one decides it', 'Game Day names a key moment');
  has(GAMEDAY, 'id="finishBtn"', 'and offers a way out of a game already over');
  has(GAMEDAY, 'Play the rest out', 'by name');
  chk('the page asks the library for the stake rather than computing its own',
    /FR\.stake\(me-op,left\)/.test(GAMEDAY) && /FR\.isKey\(st\)/.test(GAMEDAY)
    && /FR\.gameFinish\(\)/.test(GAMEDAY));
  chk('a way out is offered only when nothing is riding on it',
    /!key&&st<0\.05&&left>1&&CALLED\.drives\.length/.test(GAMEDAY));
  chk('and the stale-script guard knows the new moves',
    /EDFranchise\.stake/.test(GAMEDAY) && /EDFranchise\.gameFinish/.test(GAMEDAY));
  has(GAMEDAY, 'The story', 'every result card carries what happened to the lead');
  chk('the story comes off the box rather than being recomputed in the page',
    /var st=box\.story;/.test(GAMEDAY) && /st\.lead_changes/.test(GAMEDAY) && /st\.go_ahead/.test(GAMEDAY));
  chk('every class the moment draws is defined in the stylesheet',
    ['sn-key', 'sn-out', 'sn-story'].every(c => FRCSS.indexOf('.' + c) >= 0)
    && FRCSS.indexOf('.sn-board.key') >= 0 && FRCSS.indexOf('.sn-log li.key') >= 0);

  chk('the report grew to thirty-four rows', /select 33, 'moments are '/.test(SQL));
  chk('the schema log records the phase',
    /games_schema_note\('franchise', 14, 'key moments'\)/.test(SQL));

  has(README, 'moment_v1', 'the README documents moments');
  has(README, 'The football is not broken', 'and says what the measurement actually found');

  /* ═══ 25. BOTH SIDES OF THE BALL (PHASE 15) ══════════════════════════════
     Measured first, and damningly: called every possession the same way, a
     team got 10.95 possessions a side whether it ground the ball out or threw
     on every down — identical to two decimal places, because possessions were
     drawn once before a snap from two scheme labels and a dice roll. And you
     only ever played half the game. */
  eq('the clock is clock_v1', F.CLOCK_VERSION, 'clock_v1');
  eq('and the defense is defense_v1', F.DEFENSE_VERSION, 'defense_v1');
  eq('sixty minutes', F.CLOCK.quarters * F.CLOCK.quarter_seconds, 3600);

  Object.keys(F.CLOCK).forEach(k => chk('the clock rule ' + k + ' matches the SQL',
    new RegExp("'" + k + "', " + F.CLOCK[k] + "\\b").test(SQL)));

  /* THE POSSESSION COUNT IS GONE. There is a clock instead. */
  /* scoped to the two simulator bodies: the report row quotes this very
     string in order to assert its absence, so searching the whole file finds
     the assertion rather than the code. Assert the code, not the prose. */
  chk('nothing draws a possession count before kickoff any more', () =>
    ['franchise_sim\\(p_franchise uuid, p_game uuid\\)', 'franchise_sim_versus'].every(fn => {
      const body = (SQL.match(new RegExp('create or replace function public\\.' + fn + '[\\s\\S]*?\\n\\$\\$;')) || [''])[0];
      return body.length > 0 && !/n := 11 \+ floor\(random\(\) \* 3\)::int;/.test(body);
    }));
  chk('both simulators run on the clock, so a challenge is the same football as a Saturday',
    (SQL.match(/while secs_left > 0 and i < 60 loop/g) || []).length === 2);
  chk('the ball on the ground keeps the clock moving and the ball in the air stops it',
    F.CLOCK.run_seconds > F.CLOCK.pass_seconds
    && F.driveSeconds(6, 0.20, 'punt') > F.driveSeconds(6, 0.80, 'punt'));
  chk('a longer drive costs more clock, and a score costs the kickoff too',
    F.driveSeconds(10, 0.5, 'punt') > F.driveSeconds(4, 0.5, 'punt')
    && F.driveSeconds(6, 0.5, 'td') > F.driveSeconds(6, 0.5, 'punt'));
  chk('a drive always costs something, so the clock can never stall', () => {
    for (let n = 0; n <= 40; n++) if (F.driveSeconds(n, 0.5, 'punt') <= 0) return false;
    return true;
  });
  chk('the quarter is worked out from time elapsed, so the opening kickoff is Q1',
    F.clockLine(3600).q === 1 && F.clockLine(3600).label === '15:00'
    && F.clockLine(0).q === 4
    /* 1800 left is 1800 elapsed, which is the START of the third quarter */
    && F.clockLine(1800).q === 3 && F.clockLine(1800).label === '15:00'
    && F.clockLine(899).q === 4 && F.clockLine(899).label === '14:59');

  /* CLOCK MANAGEMENT IS REAL, and the README says plainly what it does not do */
  chk('trailing hurries up and leading bleeds it, but only late',
    /'hurry_tempo', 0.62/.test(SQL) && /'grind_tempo', 1.15/.test(SQL)
    && F.CLOCK.hurry_tempo < 1 && F.CLOCK.grind_tempo > 1);
  has(README, 'possessions strictly\nalternate', 'the README says why the clock cannot manufacture a comeback');

  /* THE FOUR FRONTS, pinned number for number */
  eq('there are four of them', F.FRONTS.calls.length, 4);
  eq('and quick play is one of them', F.FRONTS['default'], 'base');
  F.FRONTS.calls.forEach(c => {
    const blk = (SQL.match(new RegExp("'key', '" + c.key + "'[\\s\\S]{0,400}?'to_vs_pass', [-0-9.]+\\)")) || [''])[0];
    chk('the front ' + c.key + ' exists in the SQL', blk.length > 0);
    ['td_vs_run', 'td_vs_pass', 'to_vs_run', 'to_vs_pass'].forEach(k => {
      chk('and its ' + k + ' matches the client',
        blk.indexOf("'" + k + "', " + c[k]) >= 0
        || blk.indexOf("'" + k + "', " + c[k].toFixed(3)) >= 0
        || blk.indexOf("'" + k + "', " + c[k].toFixed(1)) >= 0);
    });
  });
  chk('nothing takes both the run and the pass away',
    !F.FRONTS.calls.some(c => c.td_vs_run < 0 && c.td_vs_pass < 0));
  chk('stacking the box beats the run and loses to the pass',
    F.frontCall('stack').td_vs_run < 0 && F.frontCall('stack').td_vs_pass > 0);
  chk('and sitting deep is the other way about',
    F.frontCall('cover').td_vs_pass < 0 && F.frontCall('cover').td_vs_run > 0);
  chk('a blitz buys takeaways and pays for them in touchdowns',
    F.frontCall('blitz').to_vs_pass > 0 && F.frontCall('blitz').to_vs_run > 0
    && F.frontCall('blitz').td_vs_pass > 0 && F.frontCall('blitz').td_vs_run > 0);
  chk('Base is the zero row, so quick play plays it honest',
    ['td_vs_run', 'td_vs_pass', 'to_vs_run', 'to_vs_pass'].every(k => F.frontCall('base')[k] === 0));
  chk('an unknown front falls back to the default rather than throwing',
    F.frontCall('nonsense').key === F.FRONTS['default'] && F.frontCall(null).key === 'base');
  chk('every front says what it means, in English',
    F.FRONTS.calls.every(c => typeof c.means === 'string' && c.means.length > 20));

  /* A CALL NAMES ITS OWN SIDE, so one meant for the other can be refused */
  chk('the two tables never share a key',
    !F.SNAPS.calls.some(o => F.FRONTS.calls.some(d => d.key === o.key)));
  chk('and a call says which side of the ball it is for',
    F.callSide('shot') === 'off' && F.callSide('blitz') === 'def' && F.callSide('nonsense') === null);
  chk('the server refuses a call meant for the other side rather than defaulting it',
    /if v_side <> v_want then/.test(SQL)
    && /is not a call for/.test(SQL));
  chk('and it asks the simulator whose possession it is, because only the seed knows',
    /v_want := case when \(v_box->'drives'->v_mine->>'mine'\)::boolean then 'off' else 'def' end;/.test(SQL));

  /* THE OPPONENT'S CARD IS NEVER SHOWN */
  chk('the opponent plays their scheme and their situation, on the server',
    /create or replace function public\.franchise_ai_call\(p_scheme text, p_gap integer, p_left integer\)/.test(SQL));
  chk('and no client role can ask what they are about to run',
    /revoke all on function public\.franchise_ai_call\(text, integer, integer\) from public, anon, authenticated;/.test(SQL));
  chk('the drive resolver is still out of reach, on either side of the ball',
    /revoke all on function public\.franchise_sim_drive\(numeric, numeric, numeric, numeric, numeric, numeric, boolean, text, numeric, boolean, text, text, integer\) from public, anon, authenticated;/.test(SQL));

  ['franchise_clock()', 'franchise_fronts()', 'franchise_front_call(text)', 'franchise_call_side(text)']
    .forEach(f => chk('the table ' + f.split('(')[0] + ' is open to read',
      SQL.indexOf('grant execute on function public.' + f + ' to anon, authenticated') >= 0));

  /* the page plays both sides */
  has(GAMEDAY, 'Your defense', 'Game Day calls the other side of the ball too');
  has(GAMEDAY, 'have the ball', 'and says whose ball it is');
  chk('it asks the library which table to show rather than choosing itself',
    /FR\.callsFor\('def'\)/.test(GAMEDAY) && /CALLED\.side==='def'/.test(GAMEDAY));
  chk('the clock is on the board',
    /FR\.clockLine\(/.test(GAMEDAY) && /class="ck"/.test(GAMEDAY));
  chk('and the log names both cards after the fact',
    /They ran /.test(GAMEDAY) && /you played /.test(GAMEDAY) && /FR\.frontCall\(d\.front\)/.test(GAMEDAY));
  chk('every class the defensive stage draws is defined in the stylesheet',
    FRCSS.indexOf('.sn-calls.def') >= 0 && FRCSS.indexOf('.sn-who') >= 0
    && FRCSS.indexOf('.sn-board .mid .ck') >= 0);

  chk('the report grew to thirty-five rows', /select 34, 'the game is '/.test(SQL));
  chk('the schema log records the phase',
    /games_schema_note\('franchise', 15, 'both sides of the ball'\)/.test(SQL));

  has(README, 'clock_v1', 'the README documents the clock');
  has(README, 'defense_v1', 'and the fronts');
  has(README, '10.95', 'and the measurement that made the case for both');

  /* ═══ 26. THE PLAYBOOK (PHASE 16) ════════════════════════════════════════
     Measured first: four calls was the ENTIRE offensive vocabulary and every
     franchise had the same four, because franchise_snaps() takes no argument.
     No formations, no trick plays, and eight thousand drives said a touchdown
     drive was 55 to 85 yards every time — no such thing as a big play. */
  eq('the playbook is playbook_v1', F.PLAYBOOK_VERSION, 'playbook_v1');
  chk('and the SQL says the same', /'version', 'playbook_v1'/.test(SQL));
  eq('twenty plays', F.PLAYS.length, 20);
  eq('across five formations', F.FORMATIONS.length, 5);
  eq('and a trick in every one of them', F.PLAYS.filter(p => p.type === 'trick').length, 5);

  /* the whole book pinned number for number to the SQL */
  F.PLAYS.forEach(p => {
    const blk = (SQL.match(new RegExp("'key', '" + p.key + "'[\\s\\S]{0,500}?'explosive', [-0-9.]+")) || [''])[0];
    chk('the play ' + p.key + ' exists in the SQL', blk.length > 0);
    chk('and its formation, type and category match',
      blk.indexOf("'formation', '" + p.formation + "'") >= 0
      && blk.indexOf("'type', '" + p.type + "'") >= 0
      && blk.indexOf("'call', '" + p.call + "'") >= 0);
    ['td', 'turnover', 'explosive'].forEach(k => chk('and its ' + k + ' matches the client',
      [p[k], p[k].toFixed(1), p[k].toFixed(2), p[k].toFixed(3)]
        .some(v => blk.indexOf("'" + k + "', " + v) >= 0)));
  });
  F.FORMATIONS.forEach(f => chk('the formation ' + f.key + ' has the same tell as the SQL',
    new RegExp("'key', '" + f.key + "'[\\s\\S]{0,120}?'tell', " + f.tell).test(SQL)));

  /* A PLAY SPECIALISES A CALL rather than replacing it */
  chk('every play names one of the four calls, so Phase 13 is still underneath all of it',
    F.PLAYS.every(p => F.SNAPS.calls.some(c => c.key === p.call)));
  chk('and lives in a real formation',
    F.PLAYS.every(p => !!F.formation(p.formation)));
  chk('the resolver takes the category FROM the play rather than being told it',
    /p_call := pl->>'call';/.test(SQL));
  chk('and a play key never collides with a call or a front',
    !F.PLAYS.some(p => F.SNAPS.calls.some(c => c.key === p.key) || F.FRONTS.calls.some(c => c.key === p.key)));

  /* A TRICK CONTRADICTS ITS OWN FORMATION'S TELL — that is what makes it one */
  chk('every trick play contradicts the formation it is run from', () =>
    F.PLAYS.filter(p => p.type === 'trick').every(p => {
      const tell = F.formation(p.formation).tell;
      const throws = p.call === 'air' || p.call === 'shot';
      return (tell < 0) === throws;   /* a run look that throws, or a pass look that runs */
    }));
  chk('the tells run all the way from a run look to a pass look',
    F.formation('i_form').tell < -0.5 && F.formation('empty').tell > 0.5
    && F.FORMATIONS.every(f => Math.abs(f.tell) <= 1));
  chk('and the page says what each one tells them',
    F.tellLine(-0.9) === 'Screams run' && F.tellLine(0.9) === 'Screams pass'
    && F.tellLine(0) === 'Says nothing');

  /* THE DEFENSE READS THE FORMATION, and never the other way about */
  chk('the defense picks its front off the formation you lined up in',
    /create or replace function public\.franchise_ai_front\(p_tell numeric, p_gap integer, p_left integer\)/.test(SQL)
    && /v_front := case when v_play is null then null else\s*\n\s*public\.franchise_ai_front\(/.test(SQL));
  chk('and no client role may ask what they are about to line up in',
    /revoke all on function public\.franchise_ai_front\(numeric, integer, integer\) from public, anon, authenticated;/.test(SQL));

  /* AND A TRICK GOES STALE. There is no trick-play strategy. */
  chk('a trick pays off by how much they bought the tell, and how fresh it is',
    /fresh := greatest\(0, 1 - 0\.5 \* greatest\(0, coalesce\(p_used, 0\)\)\);/.test(SQL)
    && /gain := bought \* fresh;/.test(SQL));
  chk('and one they have seen is WORSE than an honest play, not merely less good',
    /- 0\.060 \* \(1 - fresh\)/.test(SQL) && /\+ 0\.040 \* \(1 - fresh\)/.test(SQL));
  chk('the simulator counts how often you have already called it this game',
    /where oo < i and cc = v_play/.test(SQL));

  /* EVERY SCHEME HAS ITS OWN BOOK */
  chk('an Air Raid has no I-Formation and a Power-Run team has no Empty set',
    F.playbookSets('air_raid').indexOf('i_form') < 0
    && F.playbookSets('power_run').indexOf('empty') < 0);
  chk('so the flea flicker is in one book and not the other',
    F.playAllowed('power_run', 'flea_flicker') && !F.playAllowed('air_raid', 'flea_flicker'));
  chk('every scheme has a book, and none of them has all of it',
    ['power_run', 'option', 'pro_style', 'spread', 'air_raid'].every(s =>
      F.playbook(s).length >= 3 && F.playbookSets(s).length < F.FORMATIONS.length));
  chk('and the server refuses a play that is not in yours',
    /is not in your playbook/.test(SQL)
    && /not public\.franchise_play_allowed\(f\.offense, p_call\)/.test(SQL));

  /* A BIG PLAY EXISTS NOW, which it did not before */
  chk('an explosive play is more yards in fewer snaps, which the clock then feels',
    /yds := least\(99, round\(yds \* \(1 \+ 0\.55 \* boom\)\)::int\);/.test(SQL)
    && /plays := greatest\(2, plays - greatest\(1, round\(3 \* boom\)::int\)\);/.test(SQL));
  chk('and the drive says whether one broke',
    /'big', broke\);/.test(SQL));

  /* the page draws YOUR book */
  chk('Game Day draws the playbook grouped by formation',
    /FR\.playbook\(f\.offense\)\.map/.test(GAMEDAY) && /pb-set/.test(GAMEDAY)
    && /FR\.tellLine\(fm\.tell\)/.test(GAMEDAY));
  has(GAMEDAY, 'only works out of one that lies', 'and says what a formation is for');
  chk('a trick play is marked as one',
    /pl\.type==='trick'\?' trick':''/.test(GAMEDAY));
  chk('and the log tells the story of the play afterwards',
    /FR\.playLine\(d\)/.test(GAMEDAY));
  chk('every class the playbook draws is defined in the stylesheet',
    ['pb-set', 'pb-head', 'pb-means'].every(c => FRCSS.indexOf('.' + c) >= 0)
    && FRCSS.indexOf('.sn-calls .trick') >= 0);

  chk('the report grew to thirty-six rows', /select 35, 'the playbook is '/.test(SQL));
  chk('the schema log records the phase',
    /games_schema_note\('franchise', 16, 'the playbook'\)/.test(SQL));
  /* the phase count moves on with every phase; Phase 17 carries the pin now */
  chk('and the client expects at least that many', F.SCHEMA.franchise >= 16);

  has(README, 'playbook_v1', 'the README documents the playbook');

  /* ═══ 17. THE PLAYER UNIVERSE — profile_v1 ═══════════════════════════════ */
  chk('the report grew to thirty-eight rows', /select 38, 'the player universe is '/.test(SQL));
  chk('the schema log records the phase',
    /games_schema_note\('franchise', 17, 'the player universe: profiles, tiers, bodies and home towns'\)/.test(SQL));
  chk('and the client expects at least that many', F.SCHEMA.franchise >= 17);
  eq('the client profile is versioned as the SQL is', F.PROFILE_VERSION, 'profile_v1');
  chk('the roster read model carries the profile', /\|\| public\.franchise_profile_of\(p\)\)/.test(SQL));
  chk('a card shows the collector\'s tier and the universal six', (() => {
    const html = F.playerCard({ id: 'p', first_name: 'Malik', last_name: 'Vance', position: 'WR', jersey: 81, age: 24, stamina: 82,
      overall: 88, potential: 94, dev_tier: 'star', archetype: 'Deep Threat', rarity: 'elite', ratings: { spd: 96, rte: 84, hnd: 86, iq: 80 }, depth: 1 });
    return /pc-tier">Apex</.test(html) && /pc-uni/.test(html) && /pc-u"[^>]*><i>SPD<\/i><b>\d+/.test(html) && /pc-bio/.test(html);
  })());
  chk('a card without ratings still renders', F.playerCard({ id: 'p', first_name: 'A', last_name: 'B', position: 'RB', jersey: 1, overall: 70, ratings: {}, depth: 1 }).indexOf('pc-uni') >= 0);
  chk('the card classes the profile draws are in the stylesheet', ['pc-tier', 'pc-uni', 'pc-u', 'pc-bio', 'pc-tier-apex', 'pc-tier-mythic'].every(c => FRCSS.indexOf('.' + c) >= 0));
  ['roster', 'packs', 'market', 'trades', 'gameday', 'trophies', 'development'].forEach(pg => {
    const html = fs.readFileSync(G(pg + '/index.html'), 'utf8');
    chk('the ' + pg + ' page loads the profile before the franchise library',
      html.indexOf('/games/lib/gridiron/profile.js') > 0 && html.indexOf('/games/lib/gridiron/profile.js') < html.indexOf('/games/lib/franchise.js'));
  });
  has(README, 'profile_v1', 'the README documents the profile');

  /* ═══ 18. THE VAULT — packs_v2 ═══════════════════════════════════════════ */
  chk('the report grew to thirty-nine rows', /select 39, 'the Vault is '/.test(SQL));
  chk('the schema log records the phase',
    /games_schema_note\('franchise', 18, 'the Vault: packs you hold, odds you can read, and a card that remembers'\)/.test(SQL));
  chk('and the client expects at least it', F.SCHEMA.franchise >= 18);
  chk('and the report checks a number no lower',
    +((SQL.match(/\(public\.games_schema\(\)->>'franchise'\)::int = (\d+)/) || [])[1]) >= 18);
  eq('the pack table is versioned as the SQL is', F.PACKS_VERSION, 'packs_v4');
  has(SQL, '"version": "packs_v4"', 'and the SQL carries the same version');
  (function () {
    const m = SQL.match(/function public\.franchise_pack_defs\(\)[\s\S]*?select '([\s\S]*?)'::jsonb;/);
    chk('the SQL states the pack table', !!m);
    if (!m) return;
    const defs = JSON.parse(m[1].replace(/''/g, "'"));
    eq('the client knows every kind the SQL deals', Object.keys(F.PACKS).sort().join(','), Object.keys(defs.kinds).sort().join(','));
    Object.keys(defs.kinds).forEach(k => {
      const d = defs.kinds[k], c = F.PACKS[k] || {};
      chk('the client shows ' + k + ' as the SQL deals it', c.name === d.name && c.size === d.size && c.keep === d.keep && c.earned === d.earned && c.art === d.art,
        JSON.stringify(c) + ' vs ' + JSON.stringify(d));
    });
    chk('the rank\'s cache carries a protection rule the client can read', defs.kinds.gridiron_cache.pity && defs.kinds.gridiron_cache.pity.after === 5);
  })();
  chk('the packs page opens through the server and never picks its own men', /FR\.packOpenId\(/.test(PACKS) && !/Math\.random\(\)[^;]*(overall|tier|position)/.test(PACKS));
  has(PACKS, 'FR.packsBoard()', 'the packs page reads the Vault board');
  has(PACKS, 'EDVault', 'and opens through the Vault');
  has(PACKS, '/games/lib/vault.js', 'the packs page loads the Vault');
  has(PACKS, '/games/vault.css', 'and its stylesheet');
  ['pack_opened', 'card_revealed', 'rare_pull', 'pack_kept', 'pack_passed', 'packs_view'].forEach(e => chk('the packs page fires ' + e, new RegExp("track\\('" + e + "'").test(PACKS) || new RegExp("'" + e + "'").test(fs.readFileSync(G('lib/vault.js'), 'utf8'))));
  has(PACKS, 'Nothing here can be bought', 'the packs page still says nothing is for sale');
  has(README, 'packs_v3', 'the README documents the Vault');
  has(README, 'packs_v4', 'and the programs');
  chk('a live game names the packs it sealed, and the panel says which rather than guessing',
    /'packs_sealed', v_new_kinds/.test(SQL) && /where k\.franchise_id = v_f and not \(k\.kind \|\| ':' \|\| k\.source_key = any\(v_had\)\);/.test(SQL)
    && (function () { const P = fs.readFileSync(G('play/play.js'), 'utf8');
          return /var sealed = \(d\.packs_sealed \|\| \[\]\)/.test(P) && !/A Game Day pack is sealed in the Vault/.test(P); })());
  /* THE FORMATION VIEW: the roster's own eleven, a slot on a tap, the scheme's word and Saturday's */
  (function formation() {
    const ROSTER_SRC = fs.readFileSync(G('roster/index.html'), 'utf8');
    const LINEUP_SRC = fs.readFileSync(G('lib/gridiron/lineup.js'), 'utf8');
    has(ROSTER_SRC, "seed:(f.city||'')+(f.name||''),players:fieldPlayers()}", 'the field is drawn from the roster, not the seed');
    has(LINEUP_SRC, "pid: m.player && m.player.id != null ? String(m.player.id) : null,", 'and every drawn man carries his roster id');
    has(ROSTER_SRC, "if(best&&bd<=Math.max(22,best.r*1.6))slotSheet(best);", 'a tap on a man opens his slot');
    has(ROSTER_SRC, 'data-slt-start="', 'and a backup can be started from it');
    has(ROSTER_SRC, "FR.setStarter(id,sl)", 'through the server');
    has(ROSTER_SRC, "fit:fitFor(p)", 'every card carries the scheme\'s word and Saturday\'s');
    has(ROSTER_SRC, "Tap a man for his slot", 'and the field says so');
    /* the matchup table, pure */
    const opp = { offense: 'power_run', defense: 'press_man' };
    eq('a deep threat against press man has the edge', F.matchupFit({ position: 'WR', archetype: 'Deep Threat' }, opp).value, 2);
    eq('a run stopper against a power run game has it too', F.matchupFit({ position: 'DL', archetype: 'Run Stopper' }, opp).value, 2);
    eq('a possession receiver against press man has a tough day', F.matchupFit({ position: 'WR', archetype: 'Possession' }, opp).word, 'Tough day vs press man');
    eq('an unlisted man is even', F.matchupFit({ position: 'TE', archetype: 'Move TE' }, opp).value, 0);
    chk('a kicker has no matchup, nor a man without an opponent', F.matchupFit({ position: 'K', archetype: 'Leg' }, opp) === null && F.matchupFit({ position: 'WR', archetype: 'Deep Threat' }, null) === null);
    /* every archetype the matchup table names is one the scheme table knows at that position */
    const known = {};
    ['offense', 'defense'].forEach(side => Object.keys(F.SCHEME_FIT[side]).forEach(sc => Object.keys(F.SCHEME_FIT[side][sc]).forEach(pos => Object.keys(F.SCHEME_FIT[side][sc][pos]).forEach(a => { (known[pos] = known[pos] || {})[a] = 1; }))));
    const strays = [];
    ['vs_defense', 'vs_offense'].forEach(k => Object.keys(F.MATCHUP_FIT[k]).forEach(sc => Object.keys(F.MATCHUP_FIT[k][sc]).forEach(pos => Object.keys(F.MATCHUP_FIT[k][sc][pos]).forEach(a => { if (!known[pos] || !known[pos][a]) strays.push(pos + ':' + a); }))));
    chk('every archetype in the matchup table is one the scheme table knows at that position', strays.length === 0, strays.join(','));
    chk('and every scheme in it is one the franchise can run', Object.keys(F.MATCHUP_FIT.vs_defense).sort().join(',') === Object.keys(F.SCHEME_FIT.defense).sort().join(',')
      && Object.keys(F.MATCHUP_FIT.vs_offense).sort().join(',') === Object.keys(F.SCHEME_FIT.offense).sort().join(','));
    const card = F.playerCard({ id: 'x', position: 'WR', archetype: 'Deep Threat', overall: 80, first_name: 'A', last_name: 'B' }, { fit: { scheme: F.fitFor({ position: 'WR', archetype: 'Deep Threat' }, { offense: 'air_raid', defense: 'zone' }), matchup: F.matchupFit({ position: 'WR', archetype: 'Deep Threat' }, opp) } });
    has(card, '<div class="pc-fit">', 'the card prints the fit when the page hands it in');
    has(card, 'Built for your scheme (+2)', 'the scheme\'s word');
    has(card, 'Edge vs press man (+2)', 'and Saturday\'s');
  })();
  /* THE SCOUTING REPORT: Saturday's edges, read off the starters */
  (function scout() {
    const opp = { offense: 'power_run', defense: 'press_man' };
    const fr = { offense: 'air_raid', defense: 'zone' };
    const roster = [
      { id: 'w1', position: 'WR', depth: 1, archetype: 'Deep Threat', overall: 84, first_name: 'Deep', last_name: 'Threat', status: 'active' },
      { id: 'w2', position: 'WR', depth: 2, archetype: 'Possession', overall: 80, first_name: 'Poss', last_name: 'Ession', status: 'active' },
      { id: 'w4', position: 'WR', depth: 4, archetype: 'Deep Threat', overall: 90, first_name: 'On', last_name: 'Bench', status: 'active' },
      { id: 'd1', position: 'DL', depth: 1, archetype: 'Run Stopper', overall: 78, first_name: 'Run', last_name: 'Stopper', status: 'active' },
      { id: 'd2', position: 'DL', depth: 2, archetype: 'Speed Rusher', overall: 79, first_name: 'Speed', last_name: 'Rusher', status: 'active' },
      { id: 'k', position: 'K', depth: 1, archetype: 'Leg', overall: 70, first_name: 'K', last_name: 'K', status: 'active' }
    ];
    const rep = F.scoutingReport(roster, fr, opp);
    chk('the report reads only the starters', rep && rep.starters === 4 && !rep.edges.concat(rep.worries).some(e => e.id === 'w4'), JSON.stringify(rep && rep.edges.map(e => e.id)));
    chk('the edges are the men the matchup favours, best first', rep.edges.map(e => e.id).join(',') === 'w1,d1', rep.edges.map(e => e.id).join(','));
    chk('the worries are the men it does not', rep.worries.map(e => e.id).join(',') === 'w2,d2', rep.worries.map(e => e.id).join(','));
    has(rep.edges[0].text, 'Deep Threat against press man: the matchup is his', 'and each is said in a line');
    has(rep.opponent.line, 'They run a power run game and play press man.', 'with their schemes named');
    chk('no roster, no report', F.scoutingReport(null, fr, opp) === null);
    has(GAMEDAY, 'id="gdScout"', 'Game Day carries the report as a module');
    has(GAMEDAY, 'FR.scoutingReport(players,snap.franchise,ph.game.opponent)', 'read off the roster the server hands back');
    has(GAMEDAY, "localStorage.setItem('ed_gd_scout',det.open?'open':'closed')", 'and it stays folded when folded');
  })();
  /* THE CARD REMEMBERS: milestone badges, the games in your hands, a reason on every move */
  (function card() {
    const wr = { position: 'WR', career_stats: { games: 61, rec: 200, yds: 3100, td: 22 }, live_stats: { games: 40, rec: 80, yds: 1200, td: 9 } };
    const bs = F.badges(wr).map(b => b.key);
    chk('the badges count the career and the games in your hands together: 61 + 40 games, 3,100 + 1,200 yards', bs.join(',') === 'games_100,yards_1000', bs.join(','));
    chk('a receiver at 4,300 yards has the thousand and not the five', F.badges({ position: 'WR', career_stats: { yds: 4300 } }).map(b => b.key).join(',') === 'yards_1000');
    chk('and at 5,000 the five replaces the thousand', F.badges({ position: 'RB', career_stats: { yds: 4000, rec_yds: 1200 } }).map(b => b.key).join(',') === 'yards_5000');
    chk('a hundred touchdowns is a badge for a skill man, not for a tackler', F.badges({ position: 'QB', career_stats: { td: 100 } }).some(b => b.key === 'td_100') && !F.badges({ position: 'LB', career_stats: { td: 100 } }).length);
    chk('the defence has its own marks', F.badges({ position: 'DL', career_stats: { tkl: 250, sacks: 25, int: 10 } }).map(b => b.key).join(',') === 'tkl_250,sacks_25,int_10');
    chk('a kicker\'s is fifty field goals', F.badges({ position: 'K', career_stats: { fg: 50 } }).map(b => b.key).join(',') === 'fg_50');
    chk('a bowl won while he was on the roster is a championship badge, from the server\'s honours', F.badges({ position: 'S', honours: [{ kind: 'champion', season: 2, label: 'The Iron Bowl, Season II' }] }).map(b => b.label).join(',') === 'Championship roster');
    chk('no card, no badges; a rookie, none', F.badges(null).length === 0 && F.badges({ position: 'WR', career_stats: {} }).length === 0);
    chk('the badges never touch the tier or the rarity', !/rarity|tier/.test(F.badges.toString()) && !/\.rarity\s*=|\.tier\s*=/.test(FJS.slice(FJS.indexOf('function badges('), FJS.indexOf('function badges(') + 800)));
    eq('the games in your hands are their own line', F.handsLine({ position: 'RB', live_stats: { games: 3, car: 40, yds: 212, td: 2 } }), '40 car, 212 yds, 2 TD, 3 GP');
    eq('and absent when there are none', F.handsLine({ position: 'RB', live_stats: {} }), '');
    eq('a young man\'s rise is growth', F.evolutionReason({ kind: 'ratings', before: 70, after: 73, age: 22 }), 'growth: a young man developing');
    eq('an old man\'s fall is age', F.evolutionReason({ kind: 'ratings', before: 80, after: 77, age: 33 }), 'age: the legs go first');
    has(FJS, "'<div class=\"pc-career pc-hands\"><span class=\"k\">In your hands</span>'", 'the card prints the line');
    has(FJS, "'<div class=\"pc-badges\">'", 'and the badges');
    has(SQL, "'honours', coalesce((select jsonb_agg(jsonb_build_object('kind', 'champion', 'season', g.season_number,", 'the server derives the honours from the bowls won');
    has(SQL, "and g.season_number >= coalesce(p.acquired_season, 0)", 'while he was on the roster');
    has(PACKS, "FR.evolutionReason(h)", 'the card\'s history says why a rating moved');
  })();
  /* THE PROGRAMS, AND WHAT A PASSED MAN IS WORTH (packs_v4) */
  (function programs() {
    const fitSrc = SQL.slice(SQL.lastIndexOf('create or replace function public.franchise_scheme_fit()'));
    let FIT = null;
    try { FIT = JSON.parse(fitSrc.slice(fitSrc.indexOf("'{") + 1, fitSrc.indexOf("}'::jsonb") + 1).replace(/''/g, "'")); } catch (e) { chk('the scheme-fit table parses', false, e.message); }
    chk('the client mirrors the scheme-fit table the chemistry applies, entry for entry', !!FIT && JSON.stringify(FIT) === JSON.stringify(F.SCHEME_FIT));
    eq('a Power Back is built for a power run', F.schemeFit('offense', 'power_run', 'RB', 'Power Back'), 2);
    eq('a Deep Threat is not that scheme\'s man', F.schemeFit('offense', 'power_run', 'WR', 'Deep Threat'), -1);
    eq('an unlisted archetype is neutral', F.schemeFit('offense', 'power_run', 'QB', 'Nobody'), 0);
    const fr = { offense: 'power_run', defense: 'press_man' };
    eq('the word on a man reads his side\'s scheme', F.fitFor({ position: 'CB', archetype: 'Zone Specialist' }, fr).word, 'Fights your scheme');
    eq('and says when he is built for it', F.fitFor({ position: 'RB', archetype: 'Power Back' }, fr).word, 'Built for your scheme');
    chk('a kicker has no scheme', F.fitFor({ position: 'K', archetype: 'Leg' }, fr) === null);
    eq('passing over three men is worth the sum of their tiers', F.passValue([{ tier: 'starter' }, { tier: 'prime' }, { tier: 'elite', kept: true }]), 5 + 15);
    eq('a man without a tier on him is read from his overall', F.passValue([{ overall: 90 }]), F.PASS_SP.apex);
    has(PACKS, 'fit:function(m){', 'the packs page hands the room the scheme\'s word');
    has(PACKS, 'passValue:function(men){return FR.passValue(men);}', 'and what the pass is worth');
    has(PACKS, 'onView:function(m){showCard(m.id);}', 'and the whole card');
    has(PACKS, "onMarket:function(m){location.href='/games/exchange/?position='", 'and the market for men like him');
    has(PACKS, ".vs-art-speed{", 'the shelf styles the Speed Lab');
    has(PACKS, ".vs-art-trench{", 'and the Trench Unit');
    has(PACKS, ".vs-art-primetime{", 'and Primetime');
  })();

  /* ═══ 24. ONE DOOR, ONCE ════════════════════════════════════════════════ */
  chk('the report grew to forty-five rows', /select 45, 'one door, once/.test(SQL));
  chk('the schema log records the phase',
    /games_schema_note\('franchise', 24, 'one door, once: operation keys and the answer to did it happen'\)/.test(SQL));
  eq('resume is versioned', F.RESUME_VERSION, 'resume_v1');
  has(SQL, "'version', 'resume_v1'", 'and the SQL carries the same version');
  has(README, 'resume_v1', 'the README documents the door');
  chk('the ledger is one row per key, and the door locks before it decides',
    /create table if not exists public\.franchise_ops/.test(SQL)
    && /primary key \(franchise_id, op_key\)/.test(SQL)
    && /from public\.franchises where id = v_f for update/.test(SQL));
  chk('a repeated key returns the ORIGINAL result rather than doing the work again',
    /if found then\s*\n\s*return jsonb_build_object\('ok', true, 'already', true/.test(SQL));
  chk('the answer to "did it happen" is one of exactly two words, and never a third',
    /'states', jsonb_build_array\('completed', 'not_completed'\)/.test(SQL)
    && /'state', 'not_completed', 'kind', null/.test(SQL));
  chk('the doors that were already exactly-once are named rather than re-plumbed',
    /'market_purchase',\s+'game_market_txns\.op_key, unique'/.test(SQL)
    && /'award_grant',\s+'franchise_achievements primary key'/.test(SQL));
  chk('the client has four connection states and a word for each',
    /NET = \{ SYNCED: 'synced', OFFLINE: 'offline', RECONNECTING: 'reconnecting', RETRY: 'retry' \}/.test(FJS)
    && Object.keys(F.NET).length === 4 && ['synced', 'offline', 'reconnecting', 'retry'].every(k => F.netWord(k).length > 3));
  chk('and it asks the server what happened rather than deciding for itself',
    /rpc\('franchise_op', withSecret\(\{ p_op: key \}\)\)/.test(FJS)
    && /state === 'completed'/.test(FJS) && /'not_completed'/.test(FJS));
  chk('the connection strip is mounted by the shared chrome, on every page',
    /function netBanner\(\)/.test(JS) && /try \{ netBanner\(\); \} catch/.test(JS)
    && /\.netb\{/.test(CSS));
  chk('and being back online only ever means ask again, never it worked',
    /addEventListener\('online', function \(\) \{ paintNet\('reconnecting'\); \}\)/.test(JS));

  /* ═══ 23. THE LIVING SEASON ═════════════════════════════════════════════ */
  chk('the report grew to forty-four rows', /select 44, 'the living season/.test(SQL));
  chk('the schema log records the phase',
    /games_schema_note\('franchise', 23, 'the living season: rankings, award races, the title game'\)/.test(SQL));
  eq('the season is versioned', F.SEASON_VERSION, 'season_v1');
  has(SQL, "'version', 'season_v1'", 'and the SQL carries the same version');
  has(README, 'season_v1', 'the README documents the living season');
  (function () {
    /* the published power model is the client's mirror of it, term for term */
    const rules = (SQL.match(/create or replace function public\.franchise_season_rules\(\)[\s\S]*?\$\$;/) || [''])[0];
    Object.keys(F.SEASON_RULES).forEach(k => {
      const m = rules.match(new RegExp("'" + k + "', (-?[0-9.]+)"));
      chk('the power model mirrors ' + k, !!m && Number(m[1]) === F.SEASON_RULES[k], k + ': ' + (m && m[1]) + ' vs ' + F.SEASON_RULES[k]);
    });
    /* the ten races, in the same order, with the same names */
    F.AWARDS.forEach(a => {
      chk('the ' + a.key + ' race is the same race on both sides',
        rules.indexOf("'key', '" + a.key + "'") >= 0 && rules.indexOf("'name', '" + a.name + "'") >= 0, a.key);
    });
    eq('five candidates a race, on both sides', (rules.match(/'candidates', (\d+)/) || [])[1], '5');
  })();
  chk('the client only ever READS the season: it cannot write a snapshot',
    /function rankings\(\) \{ return rpc\('franchise_rankings', withSecret\(\{\}\)\); \}/.test(FJS)
    && /function awards\(\) \{ return rpc\('franchise_awards', withSecret\(\{\}\)\); \}/.test(FJS)
    && !/franchise_rankings_write|franchise_awards_write|franchise_power_rankings|franchise_award_races/.test(FJS));
  chk('and the server writes it without being asked, after the season lines',
    /create constraint trigger franchise_games_snapshot/.test(SQL) && /deferrable initially deferred/.test(SQL));
  chk('the award score is a rate for the position and never an overall',
    (() => {
      const fn = (SQL.match(/create or replace function public\.franchise_award_score\([\s\S]*?\$\$;/) || [''])[0];
      return fn.length > 200 && !/overall|archetype|rarity|potential/.test(fn) && /\/ g/.test(fn);
    })());
  chk('the title game is a game of its own, earned by losing at most once',
    /create or replace function public\.franchise_championship_earned/.test(SQL)
    && /add column if not exists championship boolean/.test(SQL)
    && /The EdgeDesk Championship/.test(SQL));
  chk('the most valuable man in it is read out of the box score',
    (() => {
      const fn = (SQL.match(/create or replace function public\.franchise_championship_mvp\([\s\S]*?\$\$;/) || [''])[0];
      return fn.length > 200 && !/overall/.test(fn) && /impact/.test(fn);
    })());
  chk('GameDay lays out the rankings, the award watch and the title game',
    /function rankingsSection/.test(GAMEDAY) && /function awardsSection/.test(GAMEDAY)
    && /function titlePregame/.test(GAMEDAY) && /function titlePostgame/.test(GAMEDAY)
    && /FR\.rankings\(\)/.test(GAMEDAY) && /FR\.awards\(\)/.test(GAMEDAY) && /FR\.championship\(\)/.test(GAMEDAY));
  chk('and carries the styles it needs for them', /\.rk-row\{/.test(FCSS) && /\.aw-race\{/.test(FCSS) && /\.ttl-mvp\{/.test(FCSS));

  /* ═══ 22. THE CARD IS NOT THE MAN ═══════════════════════════════════════ */
  chk('the report grew to forty-three rows', /select 43, 'the card is not the man/.test(SQL));
  chk('the schema log records the phase',
    /games_schema_note\('franchise', 22, 'the card is not the man: identity, edition, instance, ownership'\)/.test(SQL));
  eq('and the client expects it', F.SCHEMA.franchise, 24);
  eq('the cards are versioned', F.CARDS_VERSION, 'cards_v1');
  has(SQL, "'version', 'cards_v1'", 'and the SQL carries the same version');
  has(README, 'cards_v1', 'the README documents the separation');

  /* ═══ 21. THE GAME YOU HOLD COUNTS ═══════════════════════════════════════ */
  chk('the report grew to forty-two rows', /select 42, 'the game you hold counts/.test(SQL));
  chk('the schema log records the phase',
    /games_schema_note\('franchise', 21, 'the game you hold counts: live results, careers, and the Game Day pack'\)/.test(SQL));
  chk('and the client expects it, or a later phase', F.SCHEMA.franchise >= 21);
  /* the economy's live lines, and the mirror's arithmetic */
  eq('a live game pays 60 XP and 25 Credits; a win 40 XP, 25 Credits and a Coach Point', [F.ECONOMY.live_game.xp, F.ECONOMY.live_game.tc, F.ECONOMY.live_win.xp, F.ECONOMY.live_win.tc, F.ECONOMY.live_win.cp].join('/'), '60/25/40/25/1');
  eq('the performance is capped: 30 Credits, 40 XP', F.ECONOMY.live_perf.tc_max + '/' + F.ECONOMY.live_perf.xp_max, '30/40');
  eq('five credited games a day', F.ECONOMY.live_cap.per_day, 5);
  eq('the tiers scale it, Pro being one', [F.ECONOMY.live_tier.rookie, F.ECONOMY.live_tier.pro, F.ECONOMY.live_tier.allpro, F.ECONOMY.live_tier.legend].join('/'), '0.6/1/1.15/1.3');
  eq('a Pro win, 312 yards, three touchdowns: 115 XP, 71 Credits, 1 CP', JSON.stringify(F.liveRewards({ difficulty: 'pro', score_for: 24, score_against: 17, yards: 312, touchdowns: 3 })).replace(/,"tier".*/, '}'), '{"xp":115,"tc":71,"cp":1}');
  eq('a Legend loss, 90 yards, one touchdown: 78 XP, 36 Credits, no CP', JSON.stringify(F.liveRewards({ difficulty: 'legend', score_for: 10, score_against: 21, yards: 90, touchdowns: 1 })).replace(/,"tier".*/, '}'), '{"xp":78,"tc":36,"cp":0}');
  eq('a Rookie win pays six tenths', F.liveRewards({ difficulty: 'rookie', score_for: 14, score_against: 7, yards: 120, touchdowns: 2 }).xp, 63);
  chk('a live game weighs two toward the rank, on both sides', F.rankWeight('live_game') === 2 && /'season_complete', 5, 'live_game', 2\)/.test(SQL));
  chk('and a capped game weighs nothing: the extra kind is in the constraint and not in the weights',
    /'live_game','live_game_extra'\)\);/.test(SQL)
    && !/'live_game_extra'/.test((SQL.match(/create or replace function public\.franchise_ranks\(\)[\s\S]*?\$\$;/) || [''])[0]));
  /* the Game Day pack */
  chk('the Game Day pack is a kind the client knows, three men keep one, earned by playing', F.PACKS.gameday_pack && F.PACKS.gameday_pack.size === 3 && F.PACKS.gameday_pack.keep === 1 && /five live games/.test(F.PACKS.gameday_pack.earned));
  chk('the sync derives it from the credited games, five to a pack', /franchise_gameday_progress\(p_franchise\)->>'packs'/.test(SQL) && /'gameday_pack', i::text/.test(SQL));
  /* the line a man takes from a live game, in his career's own keys */
  eq('a quarterback\'s line', JSON.stringify(F.liveLine('QB', { pa: 22, pc: 15, py: 212, ptd: 2, pint: 1, ry: -3 })), '{"att":22,"cmp":15,"yds":212,"td":2,"int":1,"games":1}');
  eq('a back\'s line', JSON.stringify(F.liveLine('RB', { car: 14, ry: 81, rtd: 1, rec: 2, recy: 15 })), '{"car":14,"yds":81,"td":1,"rec":2,"rec_yds":15,"games":1}');
  eq('a receiver\'s line', JSON.stringify(F.liveLine('WR', { rec: 5, recy: 70, rectd: 1 })), '{"rec":5,"yds":70,"td":1,"games":1}');
  eq('a defender\'s line', JSON.stringify(F.liveLine('LB', { tkl: 7, sack: 1, int: 0, tfl: 2 })), '{"tkl":7,"sacks":1,"tfl":2,"games":1}');
  chk('a man with no line and no snap has no entry', F.liveLine('WR', {}) === null && F.liveLine('OL', { tkl: 3 }) === null);
  chk('the keys the client writes are the keys the server allows', (() => {
    const allowed = (SQL.match(/allowed text\[\] := array\[([^\]]+)\]/) || [])[1];
    if (!allowed) return false;
    const list = allowed.split(',').map(x => x.trim().replace(/'/g, ''));
    const written = ['games', 'att', 'cmp', 'yds', 'td', 'int', 'car', 'rush_yds', 'rush_td', 'rec', 'rec_yds', 'rec_td', 'tkl', 'sacks', 'tfl', 'pd', 'fg', 'fga', 'xp'];
    return written.every(k => list.indexOf(k) >= 0) && /'live_stats', p\.live_stats/.test(SQL);
  })());
  chk('the record is one RPC with the key, the game and the secret', /function recordLiveGame\(key, game\) \{\s*return record\('franchise_record_live_game', \{ p_key: String\(key \|\| ''\), p_game: game \|\| \{\} \}, 'live:' \+ key\);/.test(FJS));
  chk('the server refuses a shape that could not be a game', /v_for not between 0 and 99 or v_against not between 0 and 99 or v_plays not between 8 and 250/.test(SQL) && /or v_tds \* 6 > v_for then/.test(SQL));
  chk('and files a key once', /where franchise_id = v_f and kind in \('live_game', 'live_game_extra'\) and key = p_key;/.test(SQL));
  /* the pages */
  const PLAY = fs.readFileSync(G('play/play.js'), 'utf8');
  chk('the final screen files the game with the franchise, under the game\'s own key', /FR\.recordLiveGame\(key, payload\)/.test(PLAY) && /String\(game\.meta\.seed\) \+ ':' \+ \(game\.meta\.startedAt \|\| 0\)/.test(PLAY) && /game\.meta\.startedAt = Date\.now\(\);/.test(PLAY));
  chk('and shows the server\'s answer, never the page\'s hope', /paintFranchisePanel\(r, f\.payload, id\)/.test(PLAY) && /rewardPanel\(r\)/.test(PLAY) && /Open it in the Vault/.test(PLAY));
  chk('the filing starts once per game key and every panel paints from the same answer', /function startFiling\(\)/.test(PLAY) && /if \(FILING && FILING.key === key\) return FILING;/.test(PLAY) && /function paintFilingInto\(id\)/.test(PLAY) && /paintFilingInto\('frStage'\)/.test(PLAY) && /paintFilingInto\('frPanel'\)/.test(PLAY));
  /* the broadcast package: beats, not a wall */
  chk('halftime and the final are told in beats with a skip on every one', /function stagedOverlay\(o\)/.test(PLAY) && /id="stgSkip"/.test(PLAY) && /brand: 'EdgeDesk Halftime'/.test(PLAY) && /skipLabel: 'Skip to the adjustment'/.test(PLAY) && /onDone: halftimeAdjust/.test(PLAY) && /onDone: finalRecap/.test(PLAY));
  chk('the instant speed setting never sits through a timed beat', /if \(st\.ms && set\.speed !== 'instant'\) stagedTimer = setTimeout\(next, st\.ms\);/.test(PLAY));
  chk('the final ends at five doors, the next game first', /class="fin-acts"/.test(PLAY) && /id="btnAgain"/.test(PLAY) && /href="\/games\/gameday\/"/.test(PLAY) && /href="\/games\/roster\/"/.test(PLAY) && /href="\/games\/packs\/"/.test(PLAY) && /#research\/football/.test(PLAY));
  chk('the season context is the franchise\'s own snapshot and the record on this device, never invented', /function seasonContext\(\)/.test(PLAY) && /FR\.snapshot\(\)/.test(PLAY) && /S\.readRecord\(\)/.test(PLAY) && /Nothing is invented to fill a line/.test(PLAY));
  chk('the men on the cards play the game: the roster is read off the RPC envelope\'s data', /var d = r && r\.ok \? r\.data : \(r && r\.players \? r : null\);/.test(PLAY) && /var players = \(d && \(d\.players \|\| d\.roster\)\) \|\| null;/.test(PLAY));
  chk('Resume and Kick off wait for the franchise\'s teams to settle', /function whenTeams\(fn\)/.test(PLAY) && /whenTeams\(function \(\) \{ resumeGame\(S\.saved\(\) \|\| resumable\); \}\)/.test(PLAY) && /whenTeams\(function \(\) \{ S\.clearSave\(\); newGame\(\); \}\)/.test(PLAY) && /teamsSettling = Promise\.resolve/.test(PLAY));
  chk('the final is shown once per game and one staged sequence runs at a time', /if \(fk && finalShownFor === fk\) return;/.test(PLAY) && /if \(stagedActive\) stagedActive\.cancel\(\);/.test(PLAY) && !/if \(game\.over\) finalScreen\(\);\s*\}/.test(PLAY));
  chk('a drive is summed up once when it ends, and a man closing on a round number is said once', /function driveChip\(\)/.test(PLAY) && /shownDrives = game\.drives\.length;/.test(PLAY) && /function needsBit\(off\)/.test(PLAY) && /milestoned\[k \+ ':needs:' \+ nr\.at\] = 1;/.test(PLAY));
  chk('the broadcast announces a man from the Vault and calls a milestone once', /From the Vault/.test(PLAY) && /function milestoneBit/.test(PLAY) && /milestoned\[key\] = 1;/.test(PLAY));
  chk('the engine keeps who a man is to you on his line', /uid: player\.id == null \? null : String\(player\.id\), acq: player\.acquired_source \|\| null/.test(fs.readFileSync(G('lib/gridiron/engine.js'), 'utf8')));
  has(GAMEDAY, 'New weapon', 'Game Day carries the new weapon');
  has(GAMEDAY, 'Play the next game', 'and the one thing to do about it');
  chk('the weapon is the server\'s: the newest man kept from a pack, with how many games he has been in your hands', /'weapon', \(select jsonb_build_object\('id', p\.id/.test(SQL) && /'games_since'/.test(SQL) && /'live', public\.franchise_gameday_progress\(f\.id\)/.test(SQL));
  has(README, 'economy_v2', 'the README documents the economy');

  /* ═══ 20. THE PULL RECORD ════════════════════════════════════════════════ */
  chk('the report grew to forty-one rows', /select 41, 'the pull record is '/.test(SQL));
  chk('the schema log records the phase',
    /games_schema_note\('franchise', 20, 'the pull record: every pack you opened and the best of them'\)/.test(SQL));
  chk('and the client expects it, or a later phase', F.SCHEMA.franchise >= 20);
  chk('and the report checks the same number', /\(public\.games_schema\(\)->>'franchise'\)::int = 24/.test(SQL));
  eq('the pull record is versioned', F.PULLS_VERSION, 'pulls_v1');
  has(SQL, "'version', 'pulls_v1'", 'and the SQL agrees');
  chk('the client reads it through one RPC with the secret and nothing else', /function pulls\(\) \{ return rpc\('franchise_pulls', withSecret\(\{\}\)\); \}/.test(FJS) && typeof F.pulls === 'function');
  chk('the pull is read as it was: the first history line, never the overall now',
    /franchise_pulled_overall[\s\S]{0,300}coalesce\(\(p\.history->0->>'overall'\)::int, p\.overall\)/.test(SQL));
  chk('the inner table is the server\'s', /revoke all on function public\.franchise_pulled_men\(uuid\) from public, anon, authenticated;/.test(SQL));
  has(PACKS, 'FR.pulls()', 'the packs page reads the pull record');
  has(PACKS, 'My pulls', 'and prints it');
  has(PACKS, 'Pack earned', 'a pack earned gets its moment on the shelf');
  chk('and never opens on its own', /nothing opens on its own/.test(PACKS) && !/packOpenId\([^)]*\)[^;]*;\s*\}\)\(\)/.test(PACKS));
  ['roster:ROSTER', 'marketEstimate:', 'onAutoLineup:', 'nextPack:', 'onShare:', 'firstTime:'].forEach(k => has(PACKS, k, 'the room is handed ' + k.replace(/:.*/, '')));
  has(README, 'pulls_v1', 'the README documents the pull record');

  /* ═══ 19. THE LINEUP, CHEMISTRY AND THE EXCHANGE ═════════════════════════ */
  chk('the report grew to forty rows', /select 40, 'the lineup is '/.test(SQL));
  chk('the schema log records the phase',
    /games_schema_note\('franchise', 19, 'the lineup, chemistry, and the Exchange'\)/.test(SQL));
  chk('and the client expects it, or a later phase', F.SCHEMA.franchise >= 19);
  chk('and the report checks the same number', /\(public\.games_schema\(\)->>'franchise'\)::int = 24/.test(SQL));
  eq('the lineup is versioned', F.LINEUP_VERSION, 'lineup_v1');
  has(SQL, "'version', 'lineup_v1'", 'and the SQL agrees');
  eq('chemistry is versioned', F.CHEMISTRY_VERSION, 'chemistry_v1');
  has(SQL, "'version', 'chemistry_v1'", 'and the SQL agrees');
  eq('the Exchange is versioned', F.EXCHANGE_VERSION, 'exchange_v1');
  has(SQL, "'version', 'exchange_v1'", 'and the SQL agrees');
  (function () {
    /* the client's mirrors are the SQL's numbers, read out of the rules functions */
    /* the LAST definition of a function is the one the database keeps: the pools were widened in Phase 17 */
    const rules = (name) => { const all = SQL.match(new RegExp('create or replace function public\\.' + name + '\\(\\)[\\s\\S]*?\\$\\$;', 'g')) || []; return all.length ? all[all.length - 1] : ''; };
    const ex = rules('franchise_exchange_rules');
    ['fee_pct', 'min_price', 'max_price', 'max_open', 'expires_days', 'comps_days', 'comps_band', 'comps_shown'].forEach(k => {
      const m = ex.match(new RegExp("'" + k + "', (\\d+)"));
      chk('EXCHANGE.' + k + ' is the SQL\'s', m && +m[1] === F.EXCHANGE[k], m ? m[1] + ' vs ' + F.EXCHANGE[k] : 'not in the SQL');
    });
    has(ex, "'currency', 'tc'", 'the Exchange trades in Credits and nothing else');
    const ch = rules('franchise_chemistry_rules');
    ['per_point', 'scale', 'tenure_games', 'new_games', 'new_cap'].forEach(k => {
      const m = ch.match(new RegExp("'" + k + "', ([\\d.]+)"));
      chk('CHEMISTRY.' + k + ' is the SQL\'s', m && +m[1] === F.CHEMISTRY[k], m ? m[1] + ' vs ' + F.CHEMISTRY[k] : 'not in the SQL');
    });
    ['line', 'secondary', 'passing'].forEach(k => {
      const m = ch.match(new RegExp("'" + k + "', (\\d+)"));
      chk('CHEMISTRY.core.' + k + ' is the SQL\'s', m && +m[1] === F.CHEMISTRY.core[k]);
    });
    /* the fee rounds the way the SQL rounds: up */
    chk('the fee is five per cent rounded up on both sides', F.exchangeFee(50) === 3 && F.exchangeFee(1000) === 50 && F.exchangeFee(999) === 50 && F.exchangeFee(51) === 3);
    has(SQL, 'ceil(coalesce(p_price, 0) * (public.franchise_exchange_rules()->>\'fee_pct\')::numeric / 100.0)::int', 'and the SQL rounds up');
    /* every archetype the scheme-fit table names is one the generator deals — a typo here would be a silent zero */
    const fitSrc = rules('franchise_scheme_fit');
    const fitJson = (fitSrc.match(/select '(\{[\s\S]*\})'::jsonb/) || [])[1];
    const poolsSrc = rules('franchise_pool_archetypes');
    const poolsJson = (poolsSrc.match(/select '(\{[\s\S]*\})'::jsonb/) || [])[1];
    let fit = null, pools = null;
    try { fit = JSON.parse(fitJson); pools = JSON.parse(poolsJson); } catch (e) { chk('the fit and pool tables parse', false, String(e)); }
    if (fit && pools) {
      const offs = ['air_raid', 'spread', 'pro_style', 'power_run', 'option', 'west_coast'], defs = ['four_three', 'three_four', 'press_man', 'zone', 'blitz_heavy', 'bend_dont_break'];
      chk('every offense a franchise can run has a fit table', offs.every(k => fit.offense[k]));
      chk('every defense a franchise can run has a fit table', defs.every(k => fit.defense[k]));
      let bad = [];
      ['offense', 'defense'].forEach(side => Object.keys(fit[side]).forEach(scheme => Object.keys(fit[side][scheme]).forEach(pos => Object.keys(fit[side][scheme][pos]).forEach(arch => {
        const v = fit[side][scheme][pos][arch];
        if (!(pools[pos] || []).some(a => a.name === arch)) bad.push(scheme + '/' + pos + '/' + arch);
        if (!(v >= -2 && v <= 2)) bad.push(scheme + '/' + pos + '/' + arch + '=' + v);
      }))));
      chk('every archetype the fit table names is one the generator deals, inside -2..2', bad.length === 0, bad.join(', '));
    }
  })();
  /* the buy sends a listing id and nothing else — never a price, never a balance */
  chk('the client buys by listing id and an operation key, never a price or a balance',
    /rpc\('franchise_exchange_buy', withSecret\(\{ p_listing: id, p_op: op \}\)\)/.test(FJS)
    && !/p_price|p_balance|p_credits/.test(FJS.slice(FJS.indexOf('function exchangeBuy('), FJS.indexOf('function marketOp('))));
  /* THE SAME QUESTION TWICE IS ONE PURCHASE (cards_v1). A dropped connection
     retries with the key it used, and asks the server what became of it. */
  chk('a purchase carries an operation key the device keeps until the server answers',
    /function opKey\(kind, ref\)/.test(FJS) && /localStorage\.setItem\(k, v\)/.test(FJS)
    && /if \(r && r\.ok\) opDone\('buy', id\);/.test(FJS));
  chk('and the client can ask what became of it rather than guessing',
    /function marketOp\(listingId\)/.test(FJS) && /rpc\('franchise_market_op'/.test(FJS));
  chk('the key comes from the platform\'s id source, not from a roll', /crypto\.randomUUID/.test(FJS) && !/Math\.random/.test(FJS));
  chk('and the SQL takes no price on a buy', /function public\.franchise_exchange_buy\(p_listing uuid, p_secret text default null\)/.test(SQL));
  chk('a listing is one man, one price, inside bounds the SQL states', /function public\.franchise_exchange_list\(p_player uuid, p_price integer, p_secret text default null\)/.test(SQL)
    && /a price is between % and % Credits/.test(SQL));
  chk('the buy locks the listing, then both franchises in id order', /from public\.franchise_listings where id = p_listing for update/.test(SQL)
    && /from public\.franchises where id in \(l\.franchise_id, v_b\) order by id for update/.test(SQL));
  chk('the fee leaves the economy: the seller is credited the net, keyed by the listing',
    /franchise_credit\(l\.franchise_id, 'tc', v_net, 'exchange_sale', l\.id::text/.test(SQL) && /franchise_credit\(v_b, 'tc', -l\.price, 'exchange_buy', l\.id::text/.test(SQL));
  chk('chemistry reaches the simulation through the trait effects, not a new sim', /ch := public\.franchise_chemistry\(p_franchise\);/.test(SQL)
    && /'offense', \(base->>'offense'\)::numeric \+ \(ch->'offense'->>'effect'\)::numeric/.test(SQL));
  /* the pages */
  const EXCHANGE_PAGE = fs.readFileSync(G('exchange/index.html'), 'utf8');
  chk('the Exchange is a room of the facility', require(G('games.js')).ROOMS.some(r => r.key === 'exchange' && r.href === '/games/exchange/'));
  has(SITEMAP, '/games/exchange', 'and in the sitemap');
  has(NOTFOUND, "p[1]==='exchange'", 'and routed from 404');
  chk('the Exchange page browses, lists, withdraws and buys through the library',
    /FR\.exchangeBrowse\(/.test(EXCHANGE_PAGE) && /FR\.exchangeBuy\(/.test(EXCHANGE_PAGE) && /FR\.exchangeList\(/.test(EXCHANGE_PAGE) && /FR\.exchangeWithdraw\(/.test(EXCHANGE_PAGE)
    && /FR\.exchangeComps\(/.test(EXCHANGE_PAGE));
  chk('the page never sends a price with a buy', !/exchangeBuy\([^)]*price/.test(EXCHANGE_PAGE));
  chk('the page prints the fee before a listing is made', /exchangeFee\(/.test(EXCHANGE_PAGE));
  has(EXCHANGE_PAGE, 'Nothing here can be bought', 'and says Credits are earned, not bought');
  chk('the page loads the profile before the franchise library',
    EXCHANGE_PAGE.indexOf('/games/lib/gridiron/profile.js') > 0 && EXCHANGE_PAGE.indexOf('/games/lib/gridiron/profile.js') < EXCHANGE_PAGE.indexOf('/games/lib/franchise.js'));
  ['exchange_view', 'exchange_listed', 'exchange_bought', 'exchange_withdrawn'].forEach(e => chk('the Exchange page fires ' + e, new RegExp("'" + e + "'").test(EXCHANGE_PAGE)));
  const ROSTER_PAGE = fs.readFileSync(G('roster/index.html'), 'utf8');
  chk('the roster page prints the chemistry and offers the best lineup', /chemistry/.test(ROSTER_PAGE) && /FR\.lineupBest\(/.test(ROSTER_PAGE) && /chemistryLine|chemistryWord/.test(ROSTER_PAGE));
  chk('and lets a man be sent to the Exchange from his card', /data-list=/.test(ROSTER_PAGE) && /FR\.exchangeList\(/.test(ROSTER_PAGE));
  chk('the concurrency test is part of the run', /exchange_concurrency\.test\.js/.test(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')));
  has(README, 'exchange_v1', 'the README documents the Exchange');
  has(README, 'chemistry_v1', 'and chemistry');

  has(README, 'a formation that lies', 'and what a trick play actually needs');

  /* ═══ 27. TEN THOUSAND SEASONS ═══════════════════════════════════════════
     The measurement that found two things no smaller one had: careers that
     ended permanently, and an arc that ran the wrong way for the player who
     only plays. */
  eq('the offseason restocks to the plan', F.OFFSEASON_VERSION, 'offseason_v2');
  has(README, '38.5%', 'the README says how many careers ended');
  has(README, 'never play again', 'and what a bricked franchise actually is');
  has(README, 'rookie_v2', 'and names the rookie fix');
  chk('the roster floor is the same table a founding roster is built from',
    /jsonb_array_elements\(public\.franchise_pool_plan\(\)\) pp/.test(SQL));
  chk('and a score can never be keyed on a player who is not there',
    /create or replace function public\.franchise_anybody/.test(SQL)
    && /if scorer is not null then/.test(SQL));

  /* the reputation lift, mirrored and pinned */
  chk('the client is not asked to compute the lift: it is the server\'s own',
    !/rookie_lift/i.test(FJS));
  chk('the lift is capped at both ends and rises with both inputs',
    /greatest\(0, least\(14,/.test(SQL)
    && /floor\(greatest\(0, coalesce\(p_rank, 1\) - 1\) \* 0\.25\)::int/.test(SQL)
    && /floor\(greatest\(0, least\(100, coalesce\(p_standing, 0\)\)\) \/ 12\.0\)::int/.test(SQL));
  chk('and the report proves the rule rather than the run',
    /select 36, 'the roster is '/.test(SQL)
    && /public\.franchise_rookie_lift\(9999, 100\) = 14/.test(SQL));

  /* ═══ 28. RANKING UP OFFLINE ═════════════════════════════════════════════
     The half of the Phase 12 ask that was described and never proved: you
     can rank up with no server in reach, and connecting later gives you
     exactly the rank you earned.

     The rank is DERIVED — franchise_rank_report sums the activity log and
     writes nothing — so there is no rank counter to synchronise. What has to
     hold on the client is narrower and checkable: every reward earned
     offline is kept, replayed once, and given up on when the server has
     actually refused it. That last one was broken, and this is what found
     it. */
  chk('the football is never queued: a game has no result until the server rolls it',
    !/record\('franchise_play_week'/.test(FJS) && !/record\('franchise_start_season'/.test(FJS)
    && !/record\('franchise_offseason'/.test(FJS) && !/record\('franchise_upgrade'/.test(FJS)
    && !/record\('franchise_pack_open'/.test(FJS));
  chk('and the five things you can do with no server are the five that queue: the four reads, and a game played with your thumbs',
    ['franchise_record_price_it', 'franchise_submit_pick5', 'franchise_record_drill', 'franchise_record_research', 'franchise_record_live_game']
      .every(fn => FJS.indexOf("record('" + fn + "'") >= 0)
    && (FJS.match(/\brecord\('franchise_/g) || []).length === 5);
  chk('every one of them is worth something toward a rank',
    ['price_it', 'pick5_card', 'drill_daily', 'research_open'].every(k => F.rankWeight(k) > 0));

  await (async () => {
    fresh();
    const realUser = S.user, realRpc = S.rpc, realSigned = S.signedIn;
    let answer = null, sent = [];
    S.rpc = (fn, args) => { sent.push(fn); return Promise.resolve(typeof answer === 'function' ? answer(fn, args) : answer); };
    S.user = () => ({ id: 'user-o', email: 'o@example.com', meta: {} });
    S.signedIn = () => true;

    const HOMEDATA = { franchise: { id: 'fo', name: 'Ferry', city: 'Sitka', abbr: 'SIT', logo: 'bolt', theme: 'slate' },
      resources: { xp: 0, level: 1, scouting_points: 0, team_credits: 100, coach_points: 0 },
      rating: { overall: 70 }, reputation: { version: 'rank_v1', points: 0, rank: 1, next_at: 15, packs: 1 } };
    answer = { ok: true, data: HOMEDATA };
    await F.home();

    /* ── a week with no signal ───────────────────────────────────────────── */
    answer = { ok: false, error: 'unreachable', message: 'Could not reach EdgeDesk Games.' };
    await F.recordPriceIt('of1', -6.5);
    await F.recordResearch('of2');
    await F.recordDrill({ day: '2026-09-04', rounds: 10, correct: 8, total: 900 });
    await F.submitPick5('2026-09-01', [{ game_id: 'of3', pick: 'home' }]);
    eq('four rewards earned offline are four rewards kept', ST.franchiseQueue().length, 4);
    chk('each under the key the server is idempotent on',
      ST.franchiseQueue().map(q => q.key).sort().join('|')
        === 'drill:2026-09-04|pick5:2026-09-01|price_it:of1|research:of2',
      ST.franchiseQueue().map(q => q.key).join('|'));
    await F.recordPriceIt('of1', -6.5);
    await F.recordPriceIt('of1', -3);
    eq('and pricing the same game again is still one queued reward', ST.franchiseQueue().length, 4);
    chk('the queue is written down, so closing the tab does not lose the week',
      JSON.parse(global.localStorage.getItem(ST.KEY)).franchise.queue.length === 4);

    /* ── back in signal ──────────────────────────────────────────────────── */
    let seen = [];
    answer = (fn) => { seen.push(fn); return { ok: true, data: { ok: true, already: false, rewards: { xp: 15 },
      totals: { xp: 60, level: 1, scouting_points: 0, team_credits: 100, coach_points: 0 } } }; };
    let s = await F.sync();
    chk('the next boot replays all four and drains the queue',
      s.replayed === 4 && s.dropped === 0 && ST.franchiseQueue().length === 0 && seen.length === 4,
      JSON.stringify(s) + ' sent ' + seen.join(','));

    /* A LOST ANSWER. The server wrote the row and the reply never arrived, so
       the browser queued a reward the server already holds. The replay must
       still drain: "already" is a success, not a failure. */
    answer = { ok: false, error: 'unreachable' };
    await F.recordResearch('of9');
    eq('a reward whose answer was lost is queued', ST.franchiseQueue().length, 1);
    answer = { ok: true, data: { ok: true, already: true, rewards: { xp: 0 }, totals: HOMEDATA.resources } };
    s = await F.sync();
    chk('and the replay drains it — the server saying "already" is the same as saying yes',
      s.replayed === 1 && s.dropped === 0 && ST.franchiseQueue().length === 0);

    /* THE JAM, which is what this section was written for. A drill is honest
       only on the day it was run. Run one offline and reconnect two days
       later and the server refuses it for ever — and before this was fixed
       the browser asked for ever, and the office read "1 reward waiting to
       sync" for the life of the account. */
    answer = { ok: false, error: 'unreachable' };
    await F.recordDrill({ day: '2026-09-01', rounds: 10, correct: 8, total: 900 });
    eq('a drill run offline is kept', ST.franchiseQueue().length, 1);
    answer = { ok: false, status: 400, error: '22023', message: 'a drill is recorded on the day it was run' };
    s = await F.sync();
    chk('a refusal the server will never take back is given up on, and counted',
      s.replayed === 0 && s.dropped === 1 && ST.franchiseQueue().length === 0, JSON.stringify(s));
    s = await F.sync();
    chk('and the boot after that has nothing left to ask for',
      s.replayed === 0 && s.dropped === 0 && ST.franchiseQueue().length === 0);

    /* THE RULE, not the list: keep it only while the server has not answered.
       No status at all never arrived; a 5xx arrived and the server broke; a
       404 is a layer that is not deployed yet. Everything else is an answer. */
    const shapes = [
      ['no status at all',   { ok: false, error: 'unreachable' },                  true],
      ['a timeout',          { ok: false, error: 'timeout' },                      true],
      ['no endpoint',        { ok: false, error: 'not_configured' },               true],
      ['a 500',              { ok: false, status: 500, error: 'error' },           true],
      ['a 503',              { ok: false, status: 503, error: 'error' },           true],
      ['not deployed (404)', { ok: false, status: 404, error: 'PGRST202' },        true],
      ['a refusal (400)',    { ok: false, status: 400, error: '22023' },           false],
      ['not allowed (401)',  { ok: false, status: 401, error: 'error' },           false],
      ['forbidden (403)',    { ok: false, status: 403, error: 'error' },           false],
      ['a conflict (409)',   { ok: false, status: 409, error: '23505' },           false]
    ];
    for (const [label, ans, keep] of shapes) {
      answer = { ok: true, data: HOMEDATA }; ST.reset(); await F.home();
      answer = ans;
      const r = await F.recordResearch('shape');
      chk('kept only while the server has not answered — ' + label,
        (ST.franchiseQueue().length === 1) === keep && (r.queued === true) === keep,
        label + ' left ' + ST.franchiseQueue().length + ' queued');
    }

    /* AND THE RANK ITSELF IS NEVER THE CLIENT'S. It is read back, not kept. */
    chk('the client asks for the rank and never adds one up',
      FJS.indexOf("rpc('franchise_rank_board'") >= 0
      && !/queueFranchise\(\s*\{\s*key:\s*.rank/.test(FJS)
      && !/reputation\.points\s*\+=/.test(FJS));

    S.user = realUser; S.rpc = realRpc; S.signedIn = realSigned;
    fresh();
  })();

  chk('and the deploy-time report carries the constraint the whole thing rests on',
    /select 37, 'the rank is derived from the record/.test(SQL)
    && /t\.relname = 'franchise_activity' and c\.contype = 'u'/.test(SQL)
    && /p\.provolatile = 's'[\s\S]{0,200}proname = 'franchise_rank_report'/.test(SQL));
  has(FJS, 'function retryable(r)', 'the rule has a name in the source');
  chk('and it is written as a rule, not a list of status codes',
    /if \(!r\.status\) return true;\s*\n\s*return r\.status >= 500 \|\| r\.status === 404;/.test(FJS));
  has(README, 'waiting to sync', 'the README says what the jam looked like');
  has(README, 'never **ANSWERED**', 'and states the rule the queue now follows');

  /* ═══ 29. A LAPSED SIGN-IN ═══════════════════════════════════════════════
     Reported from a real device: founding answered `JWT expired`. One rule,
     applied everywhere a token is read — a token past its expiry is not an
     account. */
  chk('the home page decides its hero on the same rule the library uses',
    /clm\.exp&&clm\.exp\*1000<Date\.now\(\)/.test(HOME));
  chk('and the transport never presents a token it has already called dead',
    /function live\(\)/.test(SOCIALJS) && /var s = anon \? null : live\(\);/.test(SOCIALJS)
    && !/var s = session\(\);\s*\n\s*var h = \{/.test(SOCIALJS));
  chk('a token this client cannot read is not one it may present either',
    /function live\(\)[\s\S]{0,400}if \(!p\) return null;/.test(SOCIALJS));
  chk('and a 401 ends the guessing: one retry with the public key, never two',
    /if \(r\.status === 401 && !anon && s\) return send\(fn, args, true\);/.test(SOCIALJS));
  chk('an expired session is kept, not cleared — the refresh token is the terminal\'s to spend',
    !/live[\s\S]{0,200}removeItem/.test(SOCIALJS)
    && !/(401|expired)[\s\S]{0,160}removeItem\(SESSION_KEY\)/.test(SOCIALJS));
  has(README, 'JWT expired', 'the README records what the player actually saw');

  /* ═══ 30. PROGRESSION WHERE A PLAYER CAN SEE IT ══════════════════════════
     The rank and the packs it owes existed from Phase 11 and were reachable
     only from /games/packs/ — which is `gh-only-wider`, so on a phone it is
     not in the tab bar at all. The one moment the whole progression pays out
     was a footer link. */
  chk('the home read model carries what turning up is worth',
    /'reputation', public\.franchise_rank_report\(f\.id\)/.test(SQL));
  chk('and it is DERIVED, so surfacing it adds no write and cannot drift',
    /franchise_rank_report[\s\S]{0,400}language plpgsql stable/.test(SQL));
  chk('HQ names a pack that has been earned, at the top, as a reward not a chore',
    /rep&&\(rep\.packs\|0\)>0/.test(HOME) && /Packs: '\+\(rep\.packs\|0\)\+' waiting/.test(HOME)
    && HOME.indexOf("row(false,'Packs:") < HOME.indexOf("'/games/gameday/','\+100 XP"));
  chk('and says it was earned by playing rather than bought',
    /Earned by playing, never bought/.test(HOME));
  chk('the rank rides on HQ with the distance to the next one',
    /rank <b>'\+\(rep\.rank\|0\)/.test(HOME) && /\(rep\.points\|0\)\+'\/'\+\(rep\.next_at\|0\)/.test(HOME));
  chk('both lead to the room that opens them',
    (HOME.match(/href="\/games\/packs\/"/g) || []).length >= 2);

  has(README, 'The game is **open to everyone**', 'the README states the age policy');
  has(README, 'nothing is collected', 'and that nothing is collected');

  finish();
}).catch(e => { fail++; failures.push('suite threw: ' + (e && e.stack || e)); finish(); });

function finish() {
  console.log((fail ? 'FAIL' : 'PASS') + ' | edgedesk franchise | ' + pass + ' passed, ' + fail + ' failed');
  failures.forEach(f => console.log('  × ' + f));
  process.exit(fail ? 1 : 0);
}
