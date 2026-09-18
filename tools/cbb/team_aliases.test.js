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
eq('a LEADING St. is Saint and stays', T.norm("St. John's (NY)"), 'st johns ny');
eq('…likewise St. Thomas', T.norm('St. Thomas (MN)'), 'st thomas mn');
eq('Saint written out is left alone', T.norm("Saint Mary's (CA)"), 'saint marys ca');
/* the tag is kept, so the Saint/State distinction is tested without it too */
eq('…and without a tag', T.norm("St. John's"), 'st johns');

console.log('accents and apostrophes cannot decide whether a club has an archive');
eq('an accent folds', T.norm('San José State'), 'san jose state');
eq('…and matches the unaccented abbreviation', T.norm('San Jose St.'), T.norm('San José State'));
eq('an apostrophe folds', T.norm("Hawai'i"), 'hawaii');
eq('…and matches the plain spelling', T.norm('Hawaii'), T.norm("Hawai'i"));
eq('an ampersand becomes a word', T.norm('N.C. A&T'), 'north carolina a and t');
/* THE PARENTHETICAL STAYS. Folding it away made ESPN's "Cornell" and
   "Cornell (IA)" the same key, and the ambiguity guard then dropped both —
   two clubs ESPN distinguishes, made indistinguishable by the normaliser. */
eq('a state tag is kept, so tagged and untagged clubs stay distinct',
  T.norm('Miami (FL)'), 'miami fl');
ok('…so Cornell and Cornell (IA) do not collide', T.norm('Cornell') !== T.norm('Cornell (IA)'));
ok('…nor Northwestern and Northwestern (IA)',
  T.norm('Northwestern') !== T.norm('Northwestern (IA)'));
eq('…and a tag that both sources agree on matches directly',
  T.norm('Miami (OH)'), T.norm('Miami (OH)'));

console.log('two abbreviations in one name');
/* The first version of the normaliser knew "St." and not "Conn.", so
   "Central Conn. St." half-expanded and missed. */
eq('both expand', T.norm('Central Conn. St.'), 'central connecticut state');

console.log('the pair that must never collapse');
/* ESPN'S NAMES, NOT THE SCHOOLS' OWN. ESPN calls Southern California "USC" and
   calls Upstate "South Carolina Upstate" — so the token USC belongs to the
   Trojans, and the club whose NCAA name says "USC Upstate" is the one ESPN does
   NOT call USC. Getting this backwards is the whole risk. */
ok('USC points at the Trojans', /Trojans/.test(T.ALIASES.USC), T.ALIASES.USC);
ok('UPST points at South Carolina Upstate',
  /South Carolina Upstate/.test(T.ALIASES.UPST), T.ALIASES.UPST);
ok('…and UPST does NOT point at anything called just USC',
  !/^USC\b/.test(T.ALIASES.UPST), T.ALIASES.UPST);
ok('…and they are different strings', T.ALIASES.USC !== T.ALIASES.UPST);
ok('…which normalise differently too',
  T.norm(T.ALIASES.USC) !== T.norm(T.ALIASES.UPST),
  [T.norm(T.ALIASES.USC), T.norm(T.ALIASES.UPST)]);

console.log('the alias table itself');
/* NOT A FIXED COUNT. It was 35, then the normaliser fix made 25 redundant and
   7 turned out wrong; pinning the number just means the test fails whenever the
   table is corrected, which is the opposite of useful. What must hold is that
   the table is non-trivial and that no entry is junk. */
ok('the table is populated', Object.keys(T.ALIASES).length >= 20, Object.keys(T.ALIASES).length);
/* The two known-unknown clubs must stay OUT until somebody reads ESPN's list.
   An alias guessed for them is the exact failure this table already suffered. */
/* SELA took three attempts: guessed as "Southeastern Louisiana" and refused;
   the guess removed, whereupon I wrongly reported the normaliser had matched it;
   and finally read off the full club dump as "SE Louisiana". ESPN abbreviates
   where NCAA spells out, which is the reverse of every other case here. */
eq('SELA points at SE Louisiana', T.ALIASES.SELA, 'SE Louisiana');
/* AND IT IS AN ALIAS, NOT A RULE. Teaching the normaliser that "se" means
   "southeastern" would be inferred from this one club and wrong on the next:
   ESPN writes "Southeast Missouri State" in full. */
ok('…without an "se" rule that would mis-expand Southeast Missouri',
  T.norm('Southeast Missouri State') === 'southeast missouri state',
  T.norm('Southeast Missouri State'));
/* ULM was read off the full club dump: ESPN writes neither "ULM" nor "Louisiana
   Monroe" but "UL Monroe". */
eq('ULM points at UL Monroe', T.ALIASES.ULM, 'UL Monroe');

console.log('a placeholder club is never resolvable');
{
  /* ESPN's list carries entries literally named "TBD". With two of them the
     ambiguity guard drops the key anyway; with one, it would be a perfectly
     unambiguous club called TBD that an unparseable name could land on. */
  const idx = T.indexEspn([
    { id: '1', location: 'TBD', displayName: 'TBD' },
    { id: '9', location: 'Akron', displayName: 'Akron Zips' },
  ]);
  ok('a lone TBD is still not reachable', !idx.byName.has('tbd'), Array.from(idx.byName.keys()));
  ok('…while a real club beside it is', idx.byName.has('akron'));
  const res = T.resolveClubs([{ code: 'XX', name: 'TBD' }],
    [{ id: '1', location: 'TBD', displayName: 'TBD' }]);
  ok('…and a club named TBD resolves to nothing', res.unresolved.length === 1, res);
}
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
   { code: 'SJU', name: "St. John's (NY)" }, { code: 'ZZZ', name: 'Nowhere State' }],
  teams);
eq('the plain name resolves', (res.mapped.find((m) => m.code === 'AKR') || {}).espn_id, '3');
eq('…by name', (res.mapped.find((m) => m.code === 'AKR') || {}).via, 'name');
/* SJU's alias is "St. John's", which no club in this three-team fixture is
   called, so it must FAIL LOUDLY rather than fall back to a fuzzy guess. */
ok('an alias that cannot resolve is reported, not guessed around',
  res.aliasFailed.some((x) => /SJU/.test(x)), res.aliasFailed);
ok('…and that club is unresolved', res.unresolved.some((u) => u.code === 'SJU'));
/* MIA's alias is ESPN's full "Miami Hurricanes", which IS in the fixture and is
   unambiguous even though bare "Miami" is not — which is the point of aliasing
   to a displayName rather than a location. */
ok('an alias to a displayName resolves where the bare location is ambiguous',
  res.mapped.some((m) => m.code === 'MIA' && m.espn_id === '1'),
  res.mapped.filter((m) => m.code === 'MIA'));
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
