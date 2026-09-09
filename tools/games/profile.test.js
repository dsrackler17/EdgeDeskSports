#!/usr/bin/env node
/* ===========================================================================
   EDGEDESK FOOTBALL — THE PROFILE, IN TWO LANGUAGES.

   games/lib/gridiron/profile.js derives a player's full profile from the four
   ratings his card stores; supabase/games_franchise.sql restates the same
   arithmetic as franchise_profile(). This holds them together:

     1  the JavaScript is pure, bounded, and reads the archetype
     2  the constant tables in the SQL are the JavaScript's, byte for byte:
        the archetype skews, the towns, the tier thresholds
     3  against a real PostgreSQL, a few hundred random cards produce the
        same profile, tier, potential word, body and home town in both

   Without Postgres, part 3 skips loudly and passes, like the other SQL
   suites; CI runs it in games-sql.yml.

   Run: node tools/games/profile.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const P = require(path.join(ROOT, 'games', 'lib', 'gridiron', 'profile.js'));
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'games_franchise.sql'), 'utf8');

let pass = 0, fail = 0; const fails = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; fails.push('  ✗ ' + name + (detail ? ' — ' + detail : '')); } }
function eq(name, got, want) { chk(name, got === want, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
function mulberry(seed) { let a = seed >>> 0; return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/* ── 1. the JavaScript ─────────────────────────────────────────────────── */
(function js() {
  const vance = { position: 'WR', first_name: 'Malik', last_name: 'Vance', jersey: 81, age: 24, stamina: 82, overall: 88, potential: 94,
    dev_tier: 'star', archetype: 'Deep Threat', ratings: { spd: 96, rte: 84, hnd: 86, iq: 80 } };
  const pf = P.profile(vance);
  chk('a profile carries the universal six', P.UNIVERSAL.every(k => typeof pf[k] === 'number'));
  chk('and the position\'s own words', P.SPECIFIC.WR.every(k => typeof pf[k] === 'number'));
  chk('everything lands inside a rating', Object.keys(pf).filter(k => k !== 'version').every(k => pf[k] >= 30 && pf[k] <= 99));
  eq('the same card gives the same profile', JSON.stringify(P.profile(vance)), JSON.stringify(pf));
  const plain = P.profile(Object.assign({}, vance, { archetype: null }));
  chk('the archetype acts on it', plain.rel !== pf.rel || plain.spd !== pf.spd);
  chk('speed is the card\'s speed where the card has one', P.profile(Object.assign({}, vance, { archetype: null })).spd === 96);
  const twin = P.profile(Object.assign({}, vance, { last_name: 'Holloway', jersey: 11 }));
  chk('two men with the same four ratings are not the same man', JSON.stringify(twin) !== JSON.stringify(pf));
  ['QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'LB', 'CB', 'S', 'K', 'P'].forEach(pos => {
    const q = P.profile({ position: pos, overall: 70, ratings: {}, jersey: 10, age: 25, stamina: 75, last_name: 'X' });
    chk(pos + ' gets a profile from an overall alone', q && P.UNIVERSAL.every(k => typeof q[k] === 'number'));
  });
  eq('the tiers climb', [50, 62, 69, 75, 81, 87, 93, 98].map(v => P.tierOf(v).key).join(','), 'prospect,starter,impact,prime,elite,apex,legend,mythic');
  eq('a ceiling far above is a breakout', P.potentialOf({ overall: 70, potential: 84, dev_tier: 'star' }), 'breakout');
  eq('a superstar ceiling in the nineties is generational', P.potentialOf({ overall: 80, potential: 96, dev_tier: 'superstar' }), 'generational');
  eq('no ceiling is limited', P.potentialOf({ overall: 70, potential: 70, dev_tier: 'normal' }), 'limited');
  chk('a home town is on the list', P.TOWNS.indexOf(P.hometown(vance)) >= 0);
  const b = P.body(vance);
  chk('a body is plausible', b.height_in > 60 && b.height_in < 84 && b.weight_lb > 150 && b.weight_lb < 380, JSON.stringify(b));
  chk('the towns name no team, brand or person', P.TOWNS.every(t => /^[A-Z][A-Za-z .]+, [A-Z]{2}$/.test(t)));
})();

/* ── 2. the SQL carries the same tables ────────────────────────────────── */
(function tables() {
  function sqlJson(fnName) {
    const re = new RegExp("function public\\." + fnName + "\\(\\)[\\s\\S]*?select '([\\s\\S]*?)'::jsonb;");
    const m = SQL.match(re);
    return m ? JSON.parse(m[1]) : null;
  }
  const skews = sqlJson('franchise_profile_skews');
  chk('the SQL states the archetype skews', !!skews);
  eq('and they are the JavaScript\'s, key for key', JSON.stringify(skews), JSON.stringify(P.ARCH));
  const towns = SQL.match(/function public\.franchise_towns\(\)[\s\S]*?select array\[([\s\S]*?)\];/);
  chk('the SQL states the towns', !!towns);
  if (towns) {
    const list = towns[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    /* the split above cuts "Tyler, TX" in two; rebuild by pairs */
    const rebuilt = []; for (let i = 0; i < list.length; i += 2) rebuilt.push(list[i] + ', ' + list[i + 1]);
    eq('and they are the JavaScript\'s, in order', JSON.stringify(rebuilt), JSON.stringify(P.TOWNS));
  }
  P.TIERS.forEach(t => { if (t.min > 0) chk('the SQL tier ' + t.key + ' starts at ' + t.min, new RegExp("p_overall(?:, 0\\))? >= " + t.min + " then '" + t.key + "'").test(SQL)); });
  chk('the SQL profile is versioned as the JavaScript is', SQL.indexOf("'version', '" + P.VERSION + "'") >= 0);
  chk('every archetype the profile skews is one the generator can deal', Object.keys(P.ARCH).every(a => SQL.indexOf('"name":"' + a + '"') >= 0), Object.keys(P.ARCH).filter(a => SQL.indexOf('"name":"' + a + '"') < 0).join(','));
})();

/* ── 3. against a real database ────────────────────────────────────────── */
(function parity() {
  function have(bin) { return cp.spawnSync('sh', ['-c', 'command -v ' + bin], { encoding: 'utf8' }).status === 0; }
  if (!have('psql')) { console.log('SKIP | profile parity vs SQL | psql is not installed'); return; }
  const cands = [];
  if (process.env.EDGD_PG) cands.push(process.env.EDGD_PG.split(' '));
  cands.push(['-h', '/var/tmp/edgpg/sock', '-p', '5433', '-U', 'postgres']);
  cands.push(['-h', '127.0.0.1', '-p', '5432', '-U', 'postgres']);
  cands.push([]);
  let conn = null;
  for (const c of cands) {
    const r = cp.spawnSync('psql', c.concat(['-d', 'postgres', '-tAc', 'select 1']), { encoding: 'utf8' });
    if (r.status === 0 && String(r.stdout).trim() === '1') { conn = c; break; }
  }
  if (!conn) { console.log('SKIP | profile parity vs SQL | no reachable PostgreSQL server'); return; }
  const DB = 'edgedesk_profile_parity';
  const psql = (args, input) => cp.spawnSync('psql', conn.concat(args), { encoding: 'utf8', input: input });
  psql(['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB + ' (force)']);
  psql(['-d', 'postgres', '-q', '-c', 'create database ' + DB]);
  for (const f of ['tools/games/sql/supabase_shim.sql', 'supabase/games_social.sql', 'supabase/games_franchise.sql']) {
    const r = psql(['-d', DB, '-v', 'ON_ERROR_STOP=1', '-q', '-f', path.join(ROOT, f)]);
    if (r.status !== 0) { chk('the schema applies for the parity run', false, (r.stderr || '').slice(0, 300)); psql(['-d', 'postgres', '-q', '-c', 'drop database ' + DB]); return; }
  }
  /* a few hundred random cards, every position, every archetype the position can deal */
  const rand = mulberry(2026);
  const POS = ['QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'LB', 'CB', 'S', 'K', 'P'];
  const ATTRS = { QB: ['arm', 'acc', 'iq', 'spd'], RB: ['spd', 'pwr', 'elu', 'hnd'], WR: ['spd', 'rte', 'hnd', 'iq'], TE: ['hnd', 'blk', 'rte', 'spd'],
    OL: ['pbk', 'rbk', 'str', 'iq'], DL: ['prs', 'rst', 'str', 'spd'], LB: ['tkl', 'cov', 'spd', 'iq'], CB: ['cov', 'spd', 'tkl', 'bhk'],
    S: ['cov', 'tkl', 'bhk', 'iq'], K: ['pwr', 'acc', 'clu', 'con'], P: ['pwr', 'acc', 'clu', 'con'] };
  const archesByPos = {};
  const pools = JSON.parse(SQL.match(/function public\.franchise_pool_archetypes\(\)[\s\S]*?select '([\s\S]*?)'::jsonb;/)[1]);
  Object.keys(pools).forEach(pos => { archesByPos[pos] = pools[pos].map(a => a.name).concat([null]); });
  const LAST = ['Vance', 'Holloway', 'Brennan', 'Whitaker', 'Lockhart', 'Bell', 'Ricks', 'Fields', "O'Neal", 'Ndiaye', ''];
  const FIRST = ['Malik', 'Darius', 'Tyler', 'Jace', 'Andre', 'Marcus', 'Devin', 'Keon', ''];
  const cards = [];
  for (let i = 0; i < 400; i++) {
    const pos = POS[i % POS.length];
    const ratings = {};
    ATTRS[pos].forEach(k => { if (rand() < 0.92) ratings[k] = 40 + Math.floor(rand() * 60); });
    const vals = Object.keys(ratings).map(k => ratings[k]);
    const overall = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 60;
    cards.push({ position: pos, ratings: ratings, overall: overall, potential: Math.min(99, overall + Math.floor(rand() * 20)),
      dev_tier: ['normal', 'quick', 'star', 'superstar'][Math.floor(rand() * 4)],
      archetype: archesByPos[pos][Math.floor(rand() * archesByPos[pos].length)],
      jersey: rand() < 0.1 ? null : Math.floor(rand() * 100), age: 20 + Math.floor(rand() * 18),
      stamina: rand() < 0.1 ? null : 60 + Math.floor(rand() * 40),
      last_name: LAST[Math.floor(rand() * LAST.length)], first_name: FIRST[Math.floor(rand() * FIRST.length)] });
  }
  /* one query: a VALUES list in, five columns out, per card */
  const lit = v => v == null ? 'null' : "'" + String(v).replace(/'/g, "''") + "'";
  const rows = cards.map((c, i) => '(' + i + ', ' + lit(c.position) + ', ' + lit(JSON.stringify(c.ratings)) + '::jsonb, ' + c.overall + ', ' + c.potential
    + ', ' + lit(c.dev_tier) + ', ' + lit(c.archetype) + ', ' + (c.jersey == null ? 'null' : c.jersey) + ', ' + c.age + ', '
    + (c.stamina == null ? 'null' : c.stamina) + ', ' + lit(c.last_name) + ', ' + lit(c.first_name) + ')').join(',\n');
  const q = 'select i, public.franchise_profile(pos, r, ov, arch, j, a, st, ln)::text, public.franchise_card_tier(ov), '
    + 'public.franchise_potential_tier(ov, pot, dt), public.franchise_body(pos, j, a, st, ln)::text, public.franchise_hometown(j, a, st, ln, fn) '
    + 'from (values\n' + rows + '\n) as t(i, pos, r, ov, pot, dt, arch, j, a, st, ln, fn) order by i;';
  const r = psql(['-d', DB, '-v', 'ON_ERROR_STOP=1', '-tA', '-F', '\t'], q);
  psql(['-d', 'postgres', '-q', '-c', 'drop database if exists ' + DB]);
  if (r.status !== 0) { chk('the parity query runs', false, (r.stderr || '').slice(0, 300)); return; }
  const lines = r.stdout.trim().split('\n');
  eq('every card came back', lines.length, cards.length);
  let bad = 0, badTier = 0, badPot = 0, badBody = 0, badTown = 0;
  const canon = o => JSON.stringify(Object.keys(o).sort().reduce((a, k) => { a[k] = o[k]; return a; }, {}));
  lines.forEach((ln, i) => {
    const f = ln.split('\t'), c = cards[i];
    const sqlP = JSON.parse(f[1]), jsP = P.profile(c);
    if (canon(sqlP) !== canon(jsP)) { bad++; if (bad <= 3) fails.push('    card ' + i + ' ' + c.position + ' ' + (c.archetype || '-') + '\n      sql ' + canon(sqlP) + '\n      js  ' + canon(jsP)); }
    if (f[2] !== P.tierOf(c.overall).key) badTier++;
    if (f[3] !== P.potentialOf(c)) badPot++;
    if (canon(JSON.parse(f[4])) !== canon(P.body(c))) badBody++;
    if (f[5] !== P.hometown(c)) badTown++;
  });
  eq('the SQL profile and the JavaScript profile agree on every card', bad, 0);
  eq('and on every tier', badTier, 0);
  eq('and on every potential word', badPot, 0);
  eq('and on every body', badBody, 0);
  eq('and on every home town', badTown, 0);
  console.log('     (parity run: ' + cards.length + ' cards against PostgreSQL)');
})();

console.log('\nPROFILE — one profile, two languages\n  ' + pass + ' passed, ' + fail + ' failed');
if (fail) { console.log('\nFAILURES'); fails.forEach(f => console.log(f)); process.exit(1); }
