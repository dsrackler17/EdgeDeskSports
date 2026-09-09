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
    const m = man(o, 'RB');
    const pl = V.plan(m);
    eq(k + ' is premium', pl.premium, true);
    eq(k + ' names its tier', pl.tier, k);
    const kinds = pl.steps.map(s => s.kind);
    if (k === 'apex') {
      eq('apex is marked first', pl.steps[0].text, V.PREMIUM.apex);
      eq('and apex is not the top of the ladder', pl.top, false);
    } else {
      /* THE TOP OF THE LADDER IS A DIFFERENT NIGHT, not a bigger apex */
      eq(k + ' is the top of the ladder', pl.top, true);
      eq(k + ' opens with the room going to black', kinds[0], 'blackout');
      eq(k + ' calls a signal second', pl.steps[1].kind + ':' + pl.steps[1].text, 'signal:SIGNAL DETECTED');
      eq(k + ' shows its symbol before a single fact about him', kinds[2], 'symbol');
      eq(k + ' and the symbol is its own tier', pl.steps[2].tier + ':' + pl.steps[2].text, k + ':' + V.tierName(k));
      eq(k + ' goes down the tunnel before the clues', kinds[3], 'tunnel');
      chk(k + ' reads the overall before the name, the name before the lights, the lights before the card',
        kinds.indexOf('ovr') < kinds.indexOf('name') && kinds.indexOf('name') < kinds.indexOf('lights') && kinds[kinds.length - 1] === 'card');
      const ovr = pl.steps.filter(s => s.kind === 'ovr')[0];
      chk(k + ' counts the overall up from below, never down from above', ovr.from < +ovr.text && ovr.from >= 40, JSON.stringify(ovr));
      chk(k + ' never borrows the apex mark or the apex outline', !kinds.includes('mark') && !kinds.includes('silhouette'));
      chk(k + ' carries the ceiling as a clue', pl.steps.some(s => s.label === 'Ceiling'));
      chk(k + ' carries the build as a clue when the man has one', !P.body(m) || pl.steps.some(s => s.label === 'Build'));
      const clue = l => pl.steps.filter(s => s.kind === 'clue' && s.label === l)[0];
      eq(k + ': the position clue is his position', clue('Position').text, 'RB');
      eq(k + ': the archetype clue is his archetype', clue('Archetype').text, 'Deep Threat');
      eq(k + ': the ceiling clue is the profile\'s word for his ceiling', clue('Ceiling').text, V.ceilingWord(m));
    }
  });
  chk('the top sequence and the apex sequence do not even open the same way',
    V.plan(man(94, 'RB')).steps[0].kind !== V.plan(man(88, 'RB')).steps[0].kind);
  chk('a mythic and a legend share the shape but not the symbol',
    V.plan(man(98, 'RB')).steps.map(s => s.kind).join() === V.plan(man(94, 'RB')).steps.map(s => s.kind).join()
    && V.plan(man(98, 'RB')).steps[2].text !== V.plan(man(94, 'RB')).steps[2].text);
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
  chk('the longest reveal is under twelve seconds', worst <= 12000, worst + 'ms');
  chk('the top of the ladder is the longest night', V.plan(man(98, 'WR')).total >= 8000 && V.plan(man(98, 'WR')).total > V.plan(man(88, 'WR')).total,
    V.plan(man(98, 'WR')).total + ' vs ' + V.plan(man(88, 'WR')).total);
  chk('an apex reveal is five to nine seconds', V.plan(man(88, 'WR')).total >= 5000 && V.plan(man(88, 'WR')).total <= 9000, V.plan(man(88, 'WR')).total + 'ms');
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

/* ── 6. what a card does, what it sells for, how it feels in the hand ─── */
(function connect() {
  const roster = [
    { id: 'a', position: 'WR', overall: 84, status: 'active', first_name: 'A', last_name: 'One' },
    { id: 'b', position: 'WR', overall: 79, status: 'active', first_name: 'B', last_name: 'Two' },
    { id: 'c', position: 'WR', overall: 70, status: 'active', first_name: 'C', last_name: 'Three' },
    { id: 'd', position: 'WR', overall: 61, status: 'active', first_name: 'D', last_name: 'Four' },
    { id: 'q', position: 'QB', overall: 77, status: 'active', first_name: 'Q', last_name: 'Back' },
    { id: 'p', position: 'WR', overall: 99, status: 'pack', first_name: 'P', last_name: 'Table' }
  ];
  const wr2 = V.lineupImpact(man(82, 'WR'), roster);
  eq('an 82 WR into 84/79/70 starts at WR2', wr2.slot, 2);
  eq('and the gain is over the man he pushes out of the three', wr2.label, '+12 OVR at WR2');
  eq('who is named', wr2.detail, 'over C Three (70)');
  const wr4 = V.lineupImpact(man(65, 'WR'), roster);
  chk('a 65 WR does not start', !wr4.starts && wr4.slot === 4, JSON.stringify(wr4));
  eq('and the line says where he sits', wr4.label, 'WR4 on the chart');
  eq('a better QB is +3 at QB, no slot number for a one-man position', V.lineupImpact(man(80, 'QB'), roster).label, '+3 OVR at QB');
  const k = V.lineupImpact(man(70, 'K'), roster);
  eq('a position with nobody there is a whole gain', k.label + '|' + k.detail, '+70 OVR at K|nobody there before');
  chk('a man still on the table does not count as a starter', V.lineupImpact(man(90, 'WR'), roster).starts);
  chk('no roster, no line', V.lineupImpact(man(90, 'WR'), null) === null);
  chk('the starter counts are the roster page\'s', JSON.stringify(V.STARTERS) === JSON.stringify(FR.STARTERS));
  const est = V.marketEstimate({ sold: 5, median: 900, low: 700, high: 1200, asking_reference: 800 }, man(80, 'WR'));
  eq('three or more sales: the range is the sales', est.low + '-' + est.high, '700-1200');
  has(est.basis, '5 sales', 'and says so');
  const ref = V.marketEstimate({ sold: 1, median: 900, asking_reference: 800 }, man(80, 'WR'));
  eq('fewer sales: a band around the free-agent reference', ref.low + '-' + ref.high, '640-1040');
  chk('nothing to go on, no estimate: never an invented number',
    V.marketEstimate({ sold: 0, asking_reference: 0 }, man(80, 'WR')) === null && V.marketEstimate(null, man(80, 'WR')) === null);
  /* the hand and the ear learn the tier */
  P.TIERS.forEach(t => chk('a haptic pattern for ' + t.key, Array.isArray(V.HAPTIC_BY_TIER[t.key]) && V.HAPTIC_BY_TIER[t.key].length >= 1));
  chk('the top tiers have rhythms of their own',
    JSON.stringify(V.HAPTIC_BY_TIER.legend) !== JSON.stringify(V.HAPTIC_BY_TIER.apex) && JSON.stringify(V.HAPTIC_BY_TIER.mythic) !== JSON.stringify(V.HAPTIC_BY_TIER.legend));
  ['sweep', 'bass', 'rise', 'signal', 'lights', 'cut', 'rumble', 'reveal'].forEach(k => chk('the room has a sound for ' + k, typeof V.SOUND[k] === 'function'));
  /* the room's markup and the stylesheet agree */
  ['.vt-rv-beam', '.vt-rv-glitch', '.vt-rv-symbol', '.vt-sym-legend', '.vt-sym-mythic', '.vt-void', '.vt-tunnel-go', '.vt-lit', '.vt-imp', '.vt-est',
   '.vt-summary', '.vt-first', '.vt-case.held', '.vault-lite', '.vt-sig', '.vt-rv-ovr .n.land', '.vt-rv-sil.far']
    .forEach(c => has(CSS, c, 'the stylesheet dresses ' + c));
  chk('a card back is a card back: the room never puts the top bar\'s class on a card', VAULT_SRC.indexOf("' vt-premium vt-top'") < 0);
  chk('the back of a card carries the position and never the tier or the name',
    /vt-sil-pos">' \+ esc\(m\.position/.test(VAULT_SRC) && !/vt-sil-[a-z]+">' \+ esc\((pl\.tierName|fullName)/.test(VAULT_SRC));
  ['card_shared', 'pack_next', 'lineup_auto_from_pack', 'pack_opened', 'rare_pull'].forEach(e => has(VAULT_SRC, "'" + e + "'", 'the room reports ' + e));
  chk('without a document there is no card image, and no crash', V.cardImage(man(90, 'WR')) === null);
  chk('reveal all still gives a premium man his beat', /function revealAll[\s\S]*?premiums\.push/.test(VAULT_SRC));
  chk('the estimate arrives after the reveal, never in front of it', /o\.marketEstimate\) \{\s*later\(function \(\) \{[\s\S]{0,400}\}, 900\)/.test(VAULT_SRC));
  chk('the lineup line is computed from the roster handed in, never fetched', !/roster\s*=\s*.*rpc|fetch\(/.test(VAULT_SRC));
  chk('a top-tier reveal cuts the sound before the signal', /pl\.top\) \{ SOUND\.cut\(\)/.test(VAULT_SRC));
})();

if (fails.length) console.log(fails.join('\n'));
console.log((fail ? 'FAIL' : 'PASS') + ' | vault | ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
