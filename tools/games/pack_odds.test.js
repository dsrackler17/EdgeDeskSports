#!/usr/bin/env node
/* ===========================================================================
   EDGEDESK FOOTBALL — 100,000 PACKS AGAINST THE PRINTED ODDS.

   The Vault prints odds by tier on every sealed pack, and the SERVER rolls
   the pack. This holds the two together at a scale a browser never will: the
   roll the server makes (uniform over the whole numbers of the band, the
   guarantee landing on the last man, the protection lifting the ceiling) is
   mirrored here line for line — and the mirror is pinned to the SQL's own
   text, so if the server's roll ever changes this fails before it rolls.

     1  the SQL still says what the mirror says: the roll, the guarantee, the
        tier bounds, the odds arithmetic, the protection rule and its reset
     2  100,000 Gridiron Caches: every man inside his band, every pack the
        right size, nothing null or fractional, every whole number of the band
        drawn about as often as every other, and the tiers that came out
        within half a point of the odds printed on the pack
     3  25,000 Championship Vaults: one man Prime or better in every one, and
        the odds printed "for the others" hold for the others
     4  protection, on the counter the server keeps: across 100,000 caches
        nobody ever waits past the printed count for a Prime man, and the
        protected pack rolls on its lifted ceiling
     5  the odds add up to a hundred for every band the game can print

   Run: node tools/games/pack_odds.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'games_franchise.sql'), 'utf8');
const FR = require(path.join(ROOT, 'games', 'lib', 'franchise.js'));
const P = require(path.join(ROOT, 'games', 'lib', 'gridiron', 'profile.js'));

let pass = 0, fail = 0; const fails = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; fails.push('  ✗ ' + name + (detail ? ' — ' + detail : '')); } }
function has(hay, needle, name) { chk(name || ('contains ' + needle), hay.indexOf(needle) >= 0, 'missing ' + JSON.stringify(needle)); }
const pct = (a, b) => Math.round(1000 * a / Math.max(1, b)) / 10;

/* ── 1. the server's own words, so the mirror cannot drift ────────────── */
const ROLL = 'v_target := v_low + floor(random() * greatest(1, v_high - v_low + 1))::int;';
const GUAR = "if v_guar = 'prime' and i = v_size and not got_prime then v_target := greatest(v_target, least(v_high, v_prime)); end if;";
const GOT = 'if v_target >= v_prime then got_prime := true; end if;';
const BOUNDS_SQL = 'bounds int[] := array[0, 62, 69, 75, 81, 87, 93, 98, 100];';
const ODDS_SQL = 'round(100.0 * (th - tl + 1) / n, 1)';
const PITY_SQL = "coalesce(f.packs_since_prime, 0) >= (pity->>'after')::int";
const LIFT_SQL = "v_high := v_high + (pity->>'lift')::int;";
const CLAMP_SQL = 'v_high := greatest(v_low, least(99, v_high));';
const RESET_SQL = 'packs_since_prime = case when got_prime then 0 else packs_since_prime + 1 end';
[ROLL, GUAR, GOT, BOUNDS_SQL, ODDS_SQL, PITY_SQL, LIFT_SQL, CLAMP_SQL, RESET_SQL]
  .forEach(t => has(SQL, t, 'the SQL still reads: ' + t.slice(0, 64)));
chk('the roll happens inside the generator, after setseed on the pack\'s own seed',
  /perform setseed\(public\.franchise_seed_float\(pk\.seed \|\| ':' \|\| i\)\);\s*[\s\S]{0,300}v_target := v_low \+ floor\(random\(\)/.test(SQL));

const defsSrc = SQL.slice(SQL.lastIndexOf('create or replace function public.franchise_pack_defs()'));
const defsJson = defsSrc.slice(defsSrc.indexOf("'{") + 1, defsSrc.indexOf("}'::jsonb") + 1).replace(/''/g, "'");
let DEFS = null;
try { DEFS = JSON.parse(defsJson); } catch (e) { chk('the pack definitions parse', false, e.message); }
const PRIME_AT = DEFS ? DEFS.prime_at : 75;
const PITY = (DEFS && DEFS.kinds.gridiron_cache.pity) || { after: 5, lift: 6, guarantee: 'prime' };
chk('the definitions are packs_v2 with the Prime line at 75', !!DEFS && DEFS.version === 'packs_v2' && PRIME_AT === 75);
chk('the client prints the same five kinds at the same sizes and keeps',
  !!DEFS && Object.keys(DEFS.kinds).length === 5 && Object.keys(DEFS.kinds).every(k => FR.PACKS[k] && FR.PACKS[k].size === DEFS.kinds[k].size && FR.PACKS[k].keep === DEFS.kinds[k].keep));
chk('only the rank\'s cache carries protection, and only the Championship Vault a guarantee',
  !!DEFS && Object.keys(DEFS.kinds).every(k => (k === 'gridiron_cache') === !!DEFS.kinds[k].pity && (k === 'championship_vault') === (DEFS.kinds[k].guarantee === 'prime')));

const BOUNDS = [0, 62, 69, 75, 81, 87, 93, 98, 100];
const NAMES = ['prospect', 'starter', 'impact', 'prime', 'elite', 'apex', 'legend', 'mythic'];
NAMES.forEach((nm, k) => chk('the profile starts ' + nm + ' where the server does',
  P.tierOf(Math.max(40, BOUNDS[k])).key === nm && (k === 0 || P.tierOf(BOUNDS[k] - 1).key === NAMES[k - 1])));

/* ── the mirror ───────────────────────────────────────────────────────── */
function odds(low, high) {
  const n = high - low + 1, t = {};
  for (let k = 0; k < 8; k++) {
    const tl = Math.max(low, BOUNDS[k]), th = Math.min(high, BOUNDS[k + 1] - 1);
    t[NAMES[k]] = th < tl ? 0 : Math.round(1000 * (th - tl + 1) / n) / 10;
  }
  return t;
}
function tierOf(o) { for (let k = 7; k >= 0; k--) if (o >= BOUNDS[k]) return NAMES[k]; return NAMES[0]; }
function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
/* the band, as franchise_pack_band clamps it; the protection lifts the ceiling and lends a guarantee */
function band(low, high, o) {
  o = o || {};
  let guar = o.guarantee || null, active = false;
  if (o.pity && (o.since | 0) >= o.pity.after) { active = true; high += o.pity.lift; guar = guar || o.pity.guarantee; }
  high = Math.max(low, Math.min(99, high));
  return { low, high, guarantee: guar, prime_at: PRIME_AT, pity_active: active };
}
/* the roll, as franchise_pack_generate makes it */
function rollPack(b, size, rnd) {
  let got = false; const men = [];
  for (let i = 1; i <= size; i++) {
    let t = b.low + Math.floor(rnd() * Math.max(1, b.high - b.low + 1));
    if (b.guarantee === 'prime' && i === size && !got) t = Math.max(t, Math.min(b.high, b.prime_at));
    if (t >= b.prime_at) got = true;
    men.push(t);
  }
  return { men, got };
}
function tally(men, into) { men.forEach(o => { const t = tierOf(o); into[t] = (into[t] || 0) + 1; }); }
function within(obs, total, printed, tol) {
  const bad = [];
  NAMES.forEach(nm => { const got = pct(obs[nm] || 0, total); if (Math.abs(got - (printed[nm] || 0)) > tol) bad.push(nm + ' ' + got + ' vs ' + printed[nm]); });
  return bad;
}

/* ── 2. 100,000 Gridiron Caches ───────────────────────────────────────── */
(function caches() {
  const N = 100000, size = DEFS ? DEFS.kinds.gridiron_cache.size : 3;
  const b = band(62, 84), printed = odds(b.low, b.high), rnd = mulberry32(20260909);
  const tiers = {}, whole = {}; let bad = 0, sizes = 0, men = 0;
  for (let i = 0; i < N; i++) {
    const r = rollPack(b, size, rnd);
    if (r.men.length !== size) sizes++;
    r.men.forEach(o => { men++; if (!Number.isInteger(o) || o < b.low || o > b.high) bad++; whole[o] = (whole[o] || 0) + 1; });
    tally(r.men, tiers);
  }
  chk('100,000 caches: every pack the right size', sizes === 0, sizes + ' wrong');
  chk('every man a whole number inside the band, nothing null or fractional', bad === 0, bad + ' bad of ' + men);
  const expect = men / (b.high - b.low + 1);
  const off = Object.keys(whole).filter(o => Math.abs(whole[o] - expect) > expect * 0.05);
  chk('every whole number of the band is drawn about as often as every other (uniform, within 5%)', off.length === 0 && Object.keys(whole).length === b.high - b.low + 1,
    off.map(o => o + ':' + whole[o]).join(' ') + ' expected ' + Math.round(expect));
  const miss = within(tiers, men, printed, 0.5);
  chk('the tiers that came out are within half a point of the odds printed on the pack', miss.length === 0, miss.join(' | '));
  chk('the odds printed carry no chance of a tier the band cannot reach', printed.prospect === 0 && printed.legend === 0 && printed.mythic === 0 && (tiers.legend || 0) === 0 && (tiers.mythic || 0) === 0);
  chk('and a real chance of every tier it can', printed.starter > 0 && printed.impact > 0 && printed.prime > 0 && printed.elite > 0 && (tiers.elite || 0) > 0);
})();

/* ── 3. the Championship Vault's guarantee ────────────────────────────── */
(function vault() {
  const N = 25000, size = DEFS ? DEFS.kinds.championship_vault.size : 4;
  const b = band(62, 84, { guarantee: 'prime' }), printed = odds(b.low, b.high), rnd = mulberry32(777);
  const others = {}, last = {}; let kept = 0, rescued = 0, othersN = 0, lastAtLeastPrimeWhenNeeded = 0, needed = 0;
  for (let i = 0; i < N; i++) {
    const r = rollPack(b, size, rnd);
    if (r.men.some(o => o >= PRIME_AT)) kept++;
    const first = r.men.slice(0, size - 1), lastMan = r.men[size - 1];
    tally(first, others); othersN += first.length;
    tally([lastMan], last);
    if (!first.some(o => o >= PRIME_AT)) { needed++; if (lastMan >= PRIME_AT) lastAtLeastPrimeWhenNeeded++; if (lastMan === PRIME_AT) rescued++; }
  }
  chk('25,000 Championship Vaults: every one held a man Prime or better', kept === N, kept + ' of ' + N);
  chk('the guarantee lands on the last man exactly when the others missed', needed > 0 && lastAtLeastPrimeWhenNeeded === needed, lastAtLeastPrimeWhenNeeded + ' of ' + needed);
  chk('and lifts him to the Prime line, never above what the band allows', rescued > 0 && rescued <= needed);
  const miss = within(others, othersN, printed, 0.6);
  chk('the odds printed "for the others" hold for the others', miss.length === 0, miss.join(' | '));
  chk('the last man is Prime or better more often than the printed odds alone would give',
    pct((last.prime || 0) + (last.elite || 0) + (last.apex || 0), N) > printed.prime + printed.elite + printed.apex + 5);
})();

/* ── 4. protection, on the counter the server keeps ───────────────────── */
(function protection() {
  const N = 100000, size = 3, rnd = mulberry32(4242);
  let since = 0, streak = 0, worst = 0, protectedPacks = 0, protectedHeld = 0, protectedHigh = null, everyday = null;
  for (let i = 0; i < N; i++) {
    /* a low band where a Prime man is not likely, so the protection has work to do */
    const b = band(62, 80, { pity: PITY, since: since });
    if (b.pity_active) { protectedPacks++; protectedHigh = b.high; } else everyday = b.high;
    const r = rollPack(b, size, rnd);
    if (b.pity_active && r.got) protectedHeld++;
    since = r.got ? 0 : since + 1;       /* the server's own reset */
    streak = r.got ? 0 : streak + 1; worst = Math.max(worst, streak);
  }
  chk('protection fired, and never let a run go past the printed count', protectedPacks > 0 && worst <= PITY.after, 'worst run ' + worst + ', protected ' + protectedPacks);
  chk('every protected pack held the Prime man it promised', protectedHeld === protectedPacks, protectedHeld + ' of ' + protectedPacks);
  chk('the protected pack rolled on a ceiling lifted by exactly the printed lift', protectedHigh === everyday + PITY.lift, protectedHigh + ' vs ' + everyday + ' + ' + PITY.lift);
  chk('and its printed odds show more of the higher tiers than the everyday pack\'s', odds(62, protectedHigh).elite > odds(62, everyday).elite && odds(62, protectedHigh).apex >= odds(62, everyday).apex);
  chk('the counter is printed on the pack in the same words the rule uses', /'since', coalesce\(f\.packs_since_prime, 0\), 'active', v_active/.test(SQL));
})();

/* ── 5. the odds add up, for every band the game can print ────────────── */
(function sums() {
  let worst = 0, bands = 0, zeroWide = 0;
  for (let low = 40; low <= 99; low++) for (let high = low; high <= 99; high++) {
    const t = odds(low, high), sum = NAMES.reduce((a, k) => a + t[k], 0);
    worst = Math.max(worst, Math.abs(sum - 100)); bands++;
    if (NAMES.every(k => t[k] === 0)) zeroWide++;
  }
  chk('every band the game can print adds up to a hundred, to the rounding', worst <= 0.45, 'worst ' + worst + ' over ' + bands + ' bands');
  chk('and no band prints nothing', zeroWide === 0);
  const one = odds(75, 75);
  chk('a one-number band is a certainty', one.prime === 100 && NAMES.filter(k => one[k] > 0).length === 1);
  chk('the widest band the game allows reaches Mythic at the printed share', odds(40, 99).mythic === Math.round(1000 * 2 / 60) / 10);
})();

if (fails.length) console.log(fails.join('\n'));
console.log((fail ? 'FAIL' : 'PASS') + ' | pack odds | ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
