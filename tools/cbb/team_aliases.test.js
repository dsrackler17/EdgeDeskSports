#!/usr/bin/env node
/* ===========================================================================
   THE CLUB ALIAS TABLE — pure, no network.

   The live check is tools/cbb/probe_resolve_clubs.js, which needs ESPN. This
   holds the properties that must be true whatever ESPN returns.
   =========================================================================== */
'use strict';
const T = require('./team_aliases.js');
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d !== undefined ? '  ' + JSON.stringify(d) : '')); } };
const eq = (n, g, w) => ok(n, JSON.stringify(g) === JSON.stringify(w), { got: g, want: w });

console.log('normalising the two spellings of "St."');
/* Trailing is State, leading is Saint, and the position is the only tell. */
eq('a trailing St. is State', T.norm('Alabama St.'), 'alabama state');
eq('…even with another abbreviation before it', T.norm('Southeast Mo. St.'), 'southeast missouri state');
eq('a LEADING St. is Saint and stays', T.norm("St. John's (NY)"), 'st johns');
eq('…likewise St. Thomas', T.norm('St. Thomas (MN)'), 'st thomas');
eq('Saint written out is left alone', T.norm("Saint Mary's (CA)"), 'saint marys');

console.log('accents and apostrophes cannot decide whether a club has an archive');
eq('an accent folds', T.norm('San José State'), 'san jose state');
eq('…and matches the unaccented abbreviation', T.norm('San Jose St.'), T.norm('San José State'));
eq('an apostrophe folds', T.norm("Hawai'i"), 'hawaii');
eq('…and matches the plain spelling', T.norm('Hawaii'), T.norm("Hawai'i"));
eq('an ampersand becomes a word', T.norm('N.C. A&T'), 'north carolina a and t');
eq('a state disambiguator is not part of the name', T.norm('Miami (FL)'), 'miami');

console.log('two abbreviations in one name');
/* The first version of the normaliser knew "St." and not "Conn.", so
   "Central Conn. St." half-expanded and missed. */
eq('both expand', T.norm('Central Conn. St.'), 'central connecticut state');

console.log('the pair that must never collapse');
eq('USC is Southern California', T.ALIASES.USC, 'Southern California');
eq('UPST is USC Upstate', T.ALIASES.UPST, 'USC Upstate');
ok('…and they are different strings', T.ALIASES.USC !== T.ALIASES.UPST);
ok('…which normalise differently too',
  T.norm(T.ALIASES.USC) !== T.norm(T.ALIASES.UPST),
  [T.norm(T.ALIASES.USC), T.norm(T.ALIASES.UPST)]);

console.log('the alias table itself');
eq('35 aliases, one per measured miss', Object.keys(T.ALIASES).length, 35);
ok('every alias is a non-empty string',
  Object.values(T.ALIASES).every((v) => typeof v === 'string' && v.trim().length > 1));
/* Two codes pointing at one school would double a roster. */
const vals = Object.values(T.ALIASES).map(T.norm);
eq('no two aliases name the same school', vals.length, new Set(vals).size);

console.log('an ambiguous ESPN key is dropped, not given to the first claimant');
const teams = [
  { id: '1', location: 'Miami', displayName: 'Miami Hurricanes', name: 'Hurricanes' },
  { id: '2', location: 'Miami', displayName: 'Miami RedHawks', name: 'RedHawks' },
  { id: '3', location: 'Akron', displayName: 'Akron Zips', name: 'Zips' },
];
const idx = T.indexEspn(teams);
ok('the contested key is gone', !idx.byName.has('miami'), Array.from(idx.byName.keys()));
ok('…and recorded as ambiguous', idx.ambiguous.has('miami'));
ok('an uncontested key survives', idx.byName.has('akron'));
/* the distinct nicknames still resolve each club */
ok('…and each club is still reachable by its own name',
  idx.byName.has('miami hurricanes') && idx.byName.has('miami redhawks'));

console.log('resolving');
const res = T.resolveClubs(
  [{ code: 'AKR', name: 'Akron' }, { code: 'MIA', name: 'Miami (FL)' },
   { code: 'ZZZ', name: 'Nowhere State' }],
  teams);
eq('the plain name resolves', (res.mapped.find((m) => m.code === 'AKR') || {}).espn_id, '3');
eq('…by name', (res.mapped.find((m) => m.code === 'AKR') || {}).via, 'name');
/* MIA has an alias of 'Miami', which is ambiguous in this fixture, so the alias
   must FAIL LOUDLY rather than fall back to a guess. */
ok('an alias that cannot resolve is reported, not guessed around',
  res.aliasFailed.some((x) => /MIA/.test(x)), res.aliasFailed);
ok('…and that club is unresolved', res.unresolved.some((u) => u.code === 'MIA'));
ok('a club with no match anywhere is unresolved', res.unresolved.some((u) => u.code === 'ZZZ'));
ok('nothing was invented for it', !res.mapped.some((m) => m.code === 'ZZZ'));

console.log('a collision is detected rather than shipped');
const coll = T.resolveClubs(
  [{ code: 'AAA', name: 'Akron' }, { code: 'BBB', name: 'Zips' }],
  teams);
ok('two codes on one club is reported', coll.collisions.length === 1, coll.collisions);

console.log(fail ? `FAILED ${pass} passed, ${fail} failed` : `ALL GREEN ${pass} passed, 0 failed`);
console.log(fail ? `FAIL | cbb club aliases | ${fail} failed` : `PASS | cbb club aliases | ${pass} assertions`);
process.exit(fail ? 1 : 0);
