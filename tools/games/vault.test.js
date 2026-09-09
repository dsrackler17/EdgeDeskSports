#!/usr/bin/env node
/* ===========================================================================
   EDGEDESK FOOTBALL — THE VAULT'S PLAN, HELD DOWN WITHOUT A DOM.

   games/lib/vault.js is the room a pack is opened in. Everything it shows is
   a result the server already wrote, so the one thing it DECIDES — the order
   and pace of a reveal — is a pure function, EDVault.plan(man). This pins it:

     1  the clues shown before a card are the man's own facts, in order, and
        never a fact he does not have (no fake-outs, no bait)
     2  the treatment follows the collector's tier: a plain man is one step,
        a Prime or Elite man gets a short build, an Apex, Legend or Mythic
        man gets the full progressive sequence with the mark first and the
        name last
     3  the pace is bounded — nothing runs longer than a patient thumb waits
     4  the pack table the page prints (franchise.js PACKS) is the one the
        room dresses (vault.js ART), kind for kind
     5  the odds line prints every tier the server gives it and the printed
        guarantee, and says when protection is on

   Run: node tools/games/vault.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const V = require(path.join(ROOT, 'games', 'lib', 'vault.js'));
const P = require(path.join(ROOT, 'games', 'lib', 'gridiron', 'profile.js'));
const VAULT_SRC = fs.readFileSync(path.join(ROOT, 'games', 'lib', 'vault.js'), 'utf8');
const CSS = fs.readFileSync(path.join(ROOT, 'games', 'vault.css'), 'utf8');
const FR = require(path.join(ROOT, 'games', 'lib', 'franchise.js'));

let pass = 0, fail = 0; const fails = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; fails.push('  ✗ ' + name + (detail ? ' — ' + detail : '')); } }
function eq(name, got, want) { chk(name, got === want, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }
function has(hay, needle, name) { chk(name || ('contains ' + needle), hay.indexOf(needle) >= 0, 'missing ' + JSON.stringify(needle)); }

function man(overall, pos, extra) {
  const m = Object.assign({ position: pos || 'WR', first_name: 'Malik', last_name: 'Vance', jersey: 81, age: 24, stamina: 82,
    overall: overall, potential: Math.min(99, overall + 6), dev_tier: 'star', archetype: 'Deep Threat',
    ratings: { spd: overall + 6, rte: overall - 4, hnd: overall - 2, iq: overall - 8 } }, extra || {});
  m.tier = P.tierOf(m.overall).key;
  m.profile = P.profile(m);
  m.hometown = P.hometown(m);
  return m;
}

/* ── 1. the clues are the man's own facts ─────────────────────────────── */
(function facts() {
  const m = man(91, 'WR');
  const pl = V.plan(m);
  const kinds = pl.steps.map(s => s.kind);
  chk('an apex man gets the full sequence', pl.premium && pl.build);
  eq('the mark comes first', kinds[0], 'mark');
  eq('the card comes last', kinds[kinds.length - 1], 'card');
  chk('the name is the last thing before the card', kinds[kinds.length - 2] === 'name');
  chk('the overall is read before the outline and the name', kinds.indexOf('ovr') < kinds.indexOf('silhouette') && kinds.indexOf('silhouette') < kinds.indexOf('name'));
  const clue = k => pl.steps.filter(s => s.kind === 'clue' && s.label === k)[0];
  eq('the position clue is his position', clue('Position').text, 'WR');
  eq('the archetype clue is his archetype', clue('Archetype').text, 'Deep Threat');
  eq('the home clue is his home town', clue('From').text, m.hometown);
  const sig = V.signature(m);
  eq('the signature is his single best rating', sig.key, 'spd');
  eq('and the clue prints its value and its label', clue('Signature').text, sig.value + ' ' + sig.label);
  eq('the overall step is his overall', pl.steps.filter(s => s.kind === 'ovr')[0].text, '91');
  eq('the name step is his name', pl.steps.filter(s => s.kind === 'name')[0].text, 'Malik Vance');
  chk('every clue is a fact the man carries', pl.steps.filter(s => s.kind === 'clue').every(s => s.text != null && s.text !== ''));
  /* no home town, no home clue — nothing is invented to fill the pause */
  const nohome = man(91, 'WR'); delete nohome.hometown;
  chk('a man without a home town gets no home clue', !V.plan(nohome).steps.some(s => s.label === 'From'));
  const noarch = man(91, 'WR', { archetype: '' });
  chk('a man without an archetype gets no archetype clue', !V.plan(noarch).steps.some(s => s.label === 'Archetype'));
})();

/* ── 2. the treatment follows the tier ────────────────────────────────── */
(function tiers() {
  const plain = V.plan(man(66, 'OL'));
  eq('a starter is one step: the card', plain.steps.map(s => s.kind).join(','), 'card');
  chk('and is neither premium nor a build', !plain.premium && !plain.build);
  eq('a starter takes no time at all', plain.total, 0);
  const build = V.plan(man(78, 'QB'));
  chk('a prime man gets a short build', build.build && !build.premium);
  eq('the build is position, signature, overall, card', build.steps.map(s => s.kind).join(','), 'clue,clue,ovr,card');
  const elite = V.plan(man(84, 'CB'));
  chk('an elite man gets the same short build', elite.build && !elite.premium);
  ['apex', 'legend', 'mythic'].forEach((k, i) => {
    const o = [88, 94, 98][i];
    const pl = V.plan(man(o, 'RB'));
    eq(k + ' is premium', pl.premium, true);
    eq(k + ' is marked as such', pl.steps[0].text, V.PREMIUM[k]);
    eq(k + ' names its tier', pl.tier, k);
  });
  chk('confetti is kept for a legend or better', !V.plan(man(88, 'RB')).confetti && V.plan(man(94, 'RB')).confetti && V.plan(man(98, 'RB')).confetti);
  chk('the rumble belongs to premium men only', V.plan(man(88, 'RB')).rumble && !V.plan(man(78, 'RB')).rumble);
  /* the server's tier wins over the overall, if it sends one */
  const told = man(70, 'S'); told.tier = 'apex';
  eq('a tier the server sent is believed over the overall', V.plan(told).tier, 'apex');
  const untold = man(70, 'S'); delete untold.tier;
  eq('with no tier sent, the overall decides', V.plan(untold).tier, 'impact');
  chk('the tier names are the profile\'s', P.TIERS.every(t => V.tierName(t.key) === t.name));
})();

/* ── 3. the pace is bounded ───────────────────────────────────────────── */
(function pace() {
  let worst = 0;
  for (let o = 40; o <= 99; o++) ['QB', 'RB', 'WR', 'TE', 'OL', 'DL', 'LB', 'CB', 'S'].forEach(pos => {
    const pl = V.plan(man(o, pos));
    worst = Math.max(worst, pl.total);
    chk('every step has a non-negative duration (' + o + ' ' + pos + ')', pl.steps.every(s => s.ms >= 0));
    chk('a plan always ends in the card (' + o + ' ' + pos + ')', pl.steps[pl.steps.length - 1].kind === 'card');
  });
  chk('the longest reveal is under nine seconds', worst <= 9000, worst + 'ms');
  chk('and the longest reveal is long enough to be one', worst >= 5000, worst + 'ms');
  chk('a prime build is a couple of seconds', V.plan(man(78, 'QB')).total >= 1200 && V.plan(man(78, 'QB')).total <= 3000);
})();

/* ── 4. the room dresses the same packs the page prints ───────────────── */
(function art() {
  Object.keys(FR.PACKS).forEach(k => {
    const d = FR.PACKS[k];
    chk('the room has art for ' + k, !!V.ART[d.art], d.art);
    chk('the shelf styles ' + k, CSS.indexOf('vs-art-' + d.art) >= 0 || fs.readFileSync(path.join(ROOT, 'games', 'packs', 'index.html'), 'utf8').indexOf('vs-art-' + d.art) >= 0);
  });
  chk('an unknown kind falls back to the cache, never to nothing', V.artOf('nope') === V.ART.cache);
  eq('the vault kind is recognised by name', V.artOf('vault').word, 'CHAMPIONSHIP');
  /* the tiers the CSS frames are the tiers the profile knows */
  ['prime', 'elite', 'apex', 'legend', 'mythic'].forEach(t => has(CSS, '.vt-tier-' + t, 'the stylesheet frames a ' + t + ' card'));
  has(CSS, 'prefers-reduced-motion', 'the room goes still for those who ask');
  has(CSS, '.vault-still', 'and vault.js can ask for it too');
  has(VAULT_SRC, "matchMedia('(prefers-reduced-motion: reduce)')", 'vault.js reads the preference');
})();

/* ── 5. the odds line ─────────────────────────────────────────────────── */
(function odds() {
  const od = { low: 63, high: 84, tiers: { prospect: 0, starter: 27.3, impact: 27.3, prime: 27.3, elite: 18.2, apex: 0, legend: 0, mythic: 0 },
    guarantee: null, pity: { after: 5, since: 2, active: false } };
  const line = V.oddsLine(od);
  has(line, '63–84', 'the band is printed');
  has(line, 'Starter 27.3%', 'each tier with a chance is printed');
  has(line, 'Elite 18.2%');
  chk('a tier with no chance is not printed', line.indexOf('Apex') < 0 && line.indexOf('Prospect') < 0);
  chk('no guarantee, no guarantee line', line.indexOf('guaranteed') < 0);
  chk('protection off is not announced', line.indexOf('protection') < 0);
  const g = V.oddsLine(Object.assign({}, od, { guarantee: 'prime', pity: { after: 5, since: 5, active: true } }));
  has(g, 'Prime+</b> guaranteed', 'the guarantee is printed');
  has(g, 'protection active', 'and protection, when on');
  eq('no odds, no line', V.oddsLine(null), '');
  /* what the room shows is never decided here: the file is a renderer */
  chk('vault.js never calls the server', !/rpc\(|fetch\(|XMLHttpRequest|supabase/i.test(VAULT_SRC));
  chk('vault.js never writes a man\'s overall or tier', !/\.(overall|tier)\s*=[^=]/.test(VAULT_SRC));
  has(VAULT_SRC, "'pack_opened'", 'the room reports an opening');
  has(VAULT_SRC, "'card_revealed'", 'every card turned');
  has(VAULT_SRC, "'rare_pull'", 'and a rare pull');
  has(VAULT_SRC, "'pack_kept'", 'a man kept');
  has(VAULT_SRC, "'pack_passed'", 'and a pack passed');
})();

if (fails.length) console.log(fails.join('\n'));
console.log((fail ? 'FAIL' : 'PASS') + ' | vault | ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
