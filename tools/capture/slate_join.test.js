/* The football slate join: does a schedule row ever get the WRONG price?
 *
 * The schedule says "Kansas"; the odds feed says "Kansas Jayhawks". Exact
 * equality matches nothing and containment matches too much — "miami" sits
 * inside "miamiohredhawks" as happily as inside "miamihurricanes". A Miami (FL)
 * price under a Miami (OH) fixture is a wrong number on a real game, on a
 * screen someone publishes from, and it is strictly worse than showing no price
 * at all.
 *
 * So the rule is: both sides match, kickoff is close, AND exactly one candidate.
 * These assertions slice the real matcher out of app.html and run it.
 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

let pass = 0, fail = 0;
const chk = (n, ok, d) => { if (ok) { pass++; console.log('  ok   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (d ? '\n       ' + JSON.stringify(d).slice(0, 300) : '')); } };
const done = () => { console.log(fail ? `FAILED ${pass} passed, ${fail} failed`
  : `ALL GREEN ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); };

const a = APP.indexOf('var SLATE_TOL_H');
const b = APP.indexOf('function slateEvents()');
chk('the matcher is sliceable', a > -1 && b > a, { a, b });
if (a < 0 || b <= a) done();

const ctx = { console };
vm.createContext(ctx);
vm.runInContext(
  'function nrmTeam(s){return (s||"").toLowerCase().replace(/[^a-z0-9]/g,"");}\n'
  + APP.slice(a, b)
  + '\n;this.slateMatch=slateMatch;this.slateTeamHit=slateTeamHit;'
  + 'this.slateTeamIndex=slateTeamIndex;this.slateSchool=slateSchool;', ctx);
chk('it evaluates', typeof ctx.slateMatch === 'function');

/* The real school index: school + mascot + abbreviation, exactly the shape
   CFB.teams has. The Kansas / Kansas State pair is the reason this exists. */
const TEAMS = [
  { school: 'Kansas',        mascot: 'Jayhawks', abbreviation: 'KU' },
  { school: 'Kansas State',  mascot: 'Wildcats', abbreviation: 'KSU' },
  { school: 'Michigan',      mascot: 'Wolverines', abbreviation: 'MICH' },
  { school: 'Michigan State',mascot: 'Spartans', abbreviation: 'MSU' },
  { school: 'Miami',         mascot: 'Hurricanes', abbreviation: 'MIA' },
  { school: 'Miami (OH)',    mascot: 'RedHawks', abbreviation: 'M-OH' },
  { school: 'LIU',           mascot: 'Sharks', abbreviation: 'LIU' },
  { school: 'Florida',       mascot: 'Gators', abbreviation: 'FLA' },
  { school: 'Ole Miss',      mascot: 'Rebels', abbreviation: 'MISS' },
];
const IX = ctx.slateTeamIndex(TEAMS);

const KICK = '2026-09-06T16:00:00Z';
const ev = (away, home, t) => ({ away_team: away, home_team: home, commence_time: t || KICK, edge: 0.03 });
const game = (away, home, t) => ({ away_team: away, home_team: home, start_date: t || KICK });
const match = (g, evs) => ctx.slateMatch(g, evs, IX);

/* ── resolution ─────────────────────────────────────────────────────────── */
chk('a school resolves to itself', ctx.slateSchool('Kansas', IX) === 'Kansas');
chk('school + mascot resolves to the school',
  ctx.slateSchool('Kansas Jayhawks', IX) === 'Kansas');
chk('and so does the abbreviation', ctx.slateSchool('KU', IX) === 'Kansas');
chk('a name not in the index resolves to nothing',
  ctx.slateSchool('Some Random College', IX) === null);
['LIU', 'Ole Miss'].forEach(function (s) {
  chk('a short or two-word school still resolves: ' + s, ctx.slateSchool(s, IX) === s);
});

/* ── THE ONE THAT BROKE EVERY HEURISTIC ─────────────────────────────────── */
chk('Kansas and Kansas State are DIFFERENT schools',
  ctx.slateSchool('Kansas Jayhawks', IX) !== ctx.slateSchool('Kansas State Wildcats', IX));
chk('so a Kansas fixture never matches a Kansas State price',
  !ctx.slateTeamHit('Kansas', 'Kansas State Wildcats', IX));
{
  const r = match(game('LIU', 'Kansas'), [ev('LIU Sharks', 'Kansas State Wildcats')]);
  chk('and the join returns unpriced rather than the wrong game',
    r.ev === null && r.why === 'unpriced', r);
}
chk('Michigan does not match Michigan State either',
  !ctx.slateTeamHit('Michigan', 'Michigan State Spartans', IX));
{
  /* the case that would have been silently wrong: only the State game priced */
  const r = match(game('Florida', 'Michigan'), [ev('Florida Gators', 'Michigan State Spartans')]);
  chk('a Michigan game with only Michigan State on the board takes no price',
    r.ev === null, r);
}

/* ── the ordinary case still works ──────────────────────────────────────── */
{
  const r = match(game('LIU', 'Kansas'), [ev('LIU Sharks', 'Kansas Jayhawks')]);
  chk('a clean fixture matches exactly once', r.ev !== null && r.why === null, r);
}
{
  const r = match(game('Florida', 'Ole Miss'), [ev('Florida Gators', 'Ole Miss Rebels')]);
  chk('two-word schools with mascots match', r.ev !== null, r);
}

/* ── two distinct Miamis, both correctly separated ──────────────────────── */
chk('Miami and Miami (OH) are different schools',
  ctx.slateSchool('Miami Hurricanes', IX) !== ctx.slateSchool('Miami (OH) RedHawks', IX));
{
  const both = [ev('Florida Gators', 'Miami Hurricanes'), ev('Florida Gators', 'Miami (OH) RedHawks')];
  const r = match(game('Florida', 'Miami'), both);
  chk('the right Miami is picked, not an ambiguity', r.ev !== null
    && r.ev.home_team === 'Miami Hurricanes', r);
  const r2 = match(game('Florida', 'Miami (OH)'), both);
  chk('and the other Miami gets its own', r2.ev !== null
    && r2.ev.home_team === 'Miami (OH) RedHawks', r2);
}

/* ── an ambiguity is still possible and must still attach nothing ───────── */
{
  const dup = [ev('Florida Gators', 'Kansas Jayhawks'), ev('Florida Gators', 'Kansas Jayhawks')];
  const r = match(game('Florida', 'Kansas'), dup);
  chk('two fixtures for the same pairing attach nothing and say ambiguous',
    r.ev === null && r.why === 'ambiguous', r);
}

/* ── kickoff has to agree ───────────────────────────────────────────────── */
{
  const r = match(game('LIU', 'Kansas'), [ev('LIU Sharks', 'Kansas Jayhawks', '2026-09-08T16:00:00Z')]);
  chk('a fixture two days away is not the same game', r.ev === null && r.why === 'unpriced', r);
  const r2 = match(game('LIU', 'Kansas'), [ev('LIU Sharks', 'Kansas Jayhawks', '2026-09-06T22:00:00Z')]);
  chk('but feeds disagreeing by hours still match', r2.ev !== null, r2);
}

/* ── both sides required ────────────────────────────────────────────────── */
{
  const r = match(game('LIU', 'Kansas'), [ev('Florida Gators', 'Kansas Jayhawks')]);
  chk('matching only the home team is not a match', r.ev === null, r);
}

/* ── an index collision resolves to nothing rather than to a guess ──────── */
{
  const clash = ctx.slateTeamIndex([
    { school: 'Alpha', mascot: 'Xs', abbreviation: 'DUP' },
    { school: 'Beta',  mascot: 'Ys', abbreviation: 'DUP' },
  ]);
  chk('an abbreviation claimed by two schools resolves to neither',
    ctx.slateSchool('DUP', clash) === null);
  chk('while the unambiguous forms still resolve',
    ctx.slateSchool('Alpha', clash) === 'Alpha' && ctx.slateSchool('Beta Ys', clash) === 'Beta');
}

/* ── missing data is never a match ──────────────────────────────────────── */
chk('a game with no kickoff matches nothing',
  match({ away_team: 'LIU', home_team: 'Kansas' }, [ev('LIU Sharks', 'Kansas Jayhawks')]).ev === null);
chk('an empty board yields unpriced, not a throw',
  match(game('LIU', 'Kansas'), []).why === 'unpriced');
chk('a blank team name never matches', !ctx.slateTeamHit('', 'Kansas Jayhawks', IX));
chk('an empty index matches nothing at all',
  !ctx.slateTeamHit('Kansas', 'Kansas Jayhawks', ctx.slateTeamIndex([])));

/* ── the panel's own discipline, read off the source ───────────────────── */
chk('an unpriced game renders as not priced, never as a play',
  /<span class="suspect">' \+ \(g\.__why === 'ambiguous' \? 'ambiguous' : 'not priced'\)/.test(APP));
chk('and it says the schedule holds it while the board does not',
  /It is on the schedule and not on the board/.test(APP));
chk('an ambiguous game explains why nothing is attached',
  /Nothing is attached rather than guess which/.test(APP));
chk('a priced row still routes through the canonical verdict',
  /canonicalMarketVerdict\(e\)/.test(APP.slice(APP.indexOf('function renderFootballSlate'))));
chk('priced games rank by the same hierarchy as the slate above',
  /tapeRank\(a\.__ev\)/.test(APP) && /tapeRank\(b\.__ev\)/.test(APP));
chk('the match rate is reported rather than swallowed',
  /matched a priced fixture/.test(APP) && /ambiguous \(two fixtures matched; nothing attached\)/.test(APP));
chk('the slate is CFB only — cfb.games and CFB.teams are the only index there is',
  /if\(sp !== 'CFB'\) return;/.test(APP));
chk('and it says why, rather than reporting a match rate over fixtures it never held',
  /an NFL row could never resolve and would be/.test(APP));
chk('the join is on resolved school identity, not on string shape',
  /function slateTeamIndex\(teams\)\{/.test(APP)
  && /return !!\(x && y && x === y\);/.test(APP));
chk('and both discarded heuristics are recorded so neither is tried again',
  /"usc" sits inside "wisconsinbadgers"/.test(APP)
  && /is a prefix of "Kansas State Wildcats"/.test(APP));

done();
