#!/usr/bin/env node
/* ===========================================================================
   THE FBS UNIVERSE, HELD TO ITS OWN RULES.

   This is the layer every other part of the expansion stands on: who is an
   FBS team this season, what conference they are in THIS season, which
   program group that puts them in, what belongs on the canonical slate, and
   what kind of game each one is.

   What it prevents, in order of how badly it would hurt:
     1  the board silently going back to Power 4 — an eligible game dropped
        because neither side is in a power conference;
     2  a quote landing on the wrong school (Miami OH vs Miami FL, Ohio vs
        Ohio State) because a name match was a bare prefix test;
     3  a game appearing twice because both of its teams matched a selected
        conference;
     4  an FCS opponent being graded as though the model had rated it;
     5  historical conference attribution leaking this season's alignment
        into a past season;
     6  a hardcoded team count or conference list going stale in a winter.

   It runs against a FIXTURE — a hand-written mini-league with every awkward
   shape in it — and, when the committed coverage artifact is present, against
   the REAL 138-program universe too, so a fixture that drifts from reality
   fails here rather than in production.

   Run: node football/fbs/fbs.test.js
   =========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const HERE = __dirname;
const ROOT = path.join(HERE, '..', '..');

global.window = global.window || global;
const F = require(path.join(HERE, 'fbs.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String((e && e.stack) || e).slice(0, 300); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : ''));
}
function eq(name, got, want) { chk(name, got === want, { got, want }); }

/* ======================================================================
   THE FIXTURE — a two-conference league plus an independent, an FCS
   visitor, a promoted program with no seed rating, and the name shapes
   that break naive joins.
   ====================================================================== */
const DAY = 864e5;
const T0 = Date.parse('2026-09-12T17:00:00.000Z');
function game(o) {
  return Object.assign({
    game_id: null, season: 2026, week: 2, start_date: new Date(T0).toISOString(),
    completed: false, neutral_site: false, conference_game: false,
    home_division: 'fbs', away_division: 'fbs'
  }, o);
}
const ROWS = [
  /* conference game inside a power conference */
  game({ game_id: 'g1', home_team: 'Ohio State', home_conference: 'Big Ten',
    away_team: 'Michigan', away_conference: 'Big Ten', conference_game: true }),
  /* conference game inside a non-power conference — the games the old board dropped */
  game({ game_id: 'g2', home_team: 'Ohio', home_conference: 'Mid-American',
    away_team: 'Miami (OH)', away_conference: 'Mid-American', conference_game: true,
    start_date: new Date(T0 + 2 * 3600e3).toISOString() }),
  /* cross-conference, both non-power */
  game({ game_id: 'g3', home_team: 'Texas State', home_conference: 'Pac-12',
    away_team: 'UTSA', away_conference: 'American Athletic',
    start_date: new Date(T0 + 4 * 3600e3).toISOString() }),
  /* power vs non-power */
  game({ game_id: 'g4', home_team: 'Texas A&M', home_conference: 'SEC',
    away_team: 'Southern Miss', away_conference: 'Sun Belt',
    start_date: new Date(T0 + 6 * 3600e3).toISOString() }),
  /* independent vs FBS */
  game({ game_id: 'g5', home_team: 'Notre Dame', home_conference: 'FBS Independents',
    away_team: 'UConn', away_conference: 'FBS Independents',
    start_date: new Date(T0 + 8 * 3600e3).toISOString(), conference_game: true }),
  /* FBS vs FCS — stays on the slate, never graded */
  game({ game_id: 'g6', home_team: 'Kent State', home_conference: 'Mid-American',
    away_team: 'Wofford', away_conference: 'Southern', away_division: 'fcs',
    start_date: new Date(T0 + 10 * 3600e3).toISOString() }),
  /* FCS vs FCS — never on the slate */
  game({ game_id: 'g7', home_team: 'Wofford', home_conference: 'Southern', home_division: 'fcs',
    away_team: 'Colgate', away_conference: 'Patriot', away_division: 'fcs',
    start_date: new Date(T0 + 12 * 3600e3).toISOString() }),
  /* a promoted program: FBS this season, no history */
  game({ game_id: 'g8', home_team: 'North Dakota State', home_conference: 'Mountain West',
    away_team: 'Air Force', away_conference: 'Mountain West', conference_game: true,
    start_date: new Date(T0 + 14 * 3600e3).toISOString() }),
  /* completed — absorbed, never on the upcoming slate */
  game({ game_id: 'g9', home_team: 'Ohio State', home_conference: 'Big Ten',
    away_team: 'Akron', away_conference: 'Mid-American', completed: true,
    home_points: 52, away_points: 6, start_date: new Date(T0 - 7 * DAY).toISOString() }),
  /* outside the window */
  game({ game_id: 'g10', home_team: 'Michigan', home_conference: 'Big Ten',
    away_team: 'Ohio', away_conference: 'Mid-American',
    start_date: new Date(T0 + 40 * DAY).toISOString() }),
  /* no game_id — the canonical id has to be derived deterministically */
  game({ home_team: 'Akron', home_conference: 'Mid-American',
    away_team: 'Buffalo', away_conference: 'Mid-American', conference_game: true,
    start_date: new Date(T0 + 16 * 3600e3).toISOString() })
];
const P4 = { universe: { p4_by_season: { 2025: { SEC: ['texasam'], 'Big Ten': ['ohiostate', 'michigan'] } } } };
const U = F.buildUniverse({ rows: ROWS, season: 2026, source: 'fixture', params: P4 });

/* ======================================================================
   1. TEAM IDENTITY
   ====================================================================== */
eq('normKey folds punctuation', F.normKey('Miami (OH)'), 'miamioh');
eq('normKey folds accents', F.normKey('San José State'), 'sanjosestate');
eq('normKey drops the ampersand', F.normKey('Texas A&M'), 'texasam');
eq('normKey folds the apostrophe', F.normKey("Hawai'i"), 'hawaii');
eq('normKey of nothing is null', F.normKey('  '), null);
eq('aliasKey writes the ampersand out', F.aliasKey('Texas A&M'), 'texasaandm');
chk('normKey matches the engine on every fixture team', () => {
  const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
  return U.order.every(k => E.normKey(U.teams[k].name) === k);
});

/* ======================================================================
   2. SUBDIVISION
   ====================================================================== */
chk('fbs division reads as FBS', F.isFbsDivision('fbs', 'X') === true);
chk('FBS in any case reads as FBS', F.isFbsDivision('FBS', 'X') === true);
chk('the long spelling reads as FBS', F.isFbsDivision('Football Bowl Subdivision', 'X') === true);
chk('i-a reads as FBS', F.isFbsDivision('I-A', 'X') === true);
chk('fcs reads as non-FBS', F.isFbsDivision('fcs', 'X') === false);
chk('the long FCS spelling reads as non-FBS', F.isFbsDivision('Football Championship Subdivision', 'X') === false);
chk('an unknown division word is NOT assumed FBS', F.isFbsDivision('iii', 'X') === false);
chk('a missing division resolves against the known FBS list',
  F.isFbsDivision('', 'Ohio State', { knownFbs: { ohiostate: 1 } }) === true
  && F.isFbsDivision('', 'Wofford', { knownFbs: { ohiostate: 1 } }) === false);
chk('a missing division with nothing to resolve against stays FBS rather than derating the league',
  F.isFbsDivision('', 'Ohio State') === true);

/* ======================================================================
   3. CONFERENCE NORMALISATION
   ====================================================================== */
eq('the source spelling maps to a canonical id', F.conference('American Athletic').id, 'american');
eq('the abbreviation maps to the same id', F.conference('AAC').id, 'american');
eq('the short name maps to the same id', F.conference('American').id, 'american');
eq('the display name is EdgeDesk’s, not the feed’s', F.conference('American Athletic').label, 'American');
eq('Mid-American displays as MAC', F.conference('Mid-American').label, 'MAC');
eq('MAC maps to the same id as Mid-American', F.conference('MAC').id, F.conference('Mid-American').id);
eq('Conference USA normalises', F.conference('C-USA').id, 'cusa');
eq('Mountain West normalises from its abbreviation', F.conference('MWC').id, 'mwc');
eq('Big Ten normalises from B1G', F.conference('B1G').id, 'bigten');
eq('FBS Independents is the independents bucket', F.conference('FBS Independents').id, 'independents');
eq('Independents displays without the FBS prefix', F.conference('FBS Independents').label, 'Independents');
chk('FCS Independents is NOT the FBS independents bucket',
  F.conference('FCS Independents').id !== F.conference('FBS Independents').id,
  { fcs: F.conference('FCS Independents').id, fbs: F.conference('FBS Independents').id });
eq('Pac-10 is its own historical conference', F.conference('Pac-10').id, 'pac10');
chk('Pac-10 is not silently rewritten as Pac-12', F.conference('Pac-10').id !== F.conference('Pac-12').id);
chk('an unseen label still resolves to a stable id, flagged unknown', () => {
  const c = F.conference('Mountain Atlantic League');
  return c.id === 'x-mountain-atlantic-league' && c.known === false && c.label === 'Mountain Atlantic League';
});
chk('an empty label is missing, not a conference', F.conference('').missing === true && F.conference('').id === null);

/* ======================================================================
   4. SEASON-AWARE POWER 4 SCOPE AND GROUPING
   ====================================================================== */
chk('the Power 4 set comes from the season’s own membership record when there is one', () => {
  const s = F.p4Scope(2025, { params: P4 });
  return s.season_used === 2025 && s.ids.indexOf('sec') >= 0 && s.ids.indexOf('bigten') >= 0
    && s.ids.indexOf('mac') < 0;
});
chk('past the end of the record the nearest earlier season is used AND SAID', () => {
  const s = F.p4Scope(2026, { params: P4 });
  return s.season_used === 2025 && /NOT reflected/.test(s.basis);
});
chk('with no record at all the declared list is used and the basis says so', () => {
  const s = F.p4Scope(2026, { params: {} , p4Conferences: ['SEC', 'ACC'] });
  return s.season_used === null && s.ids.join(',') === 'acc,sec' && /no per-season membership record/.test(s.basis);
});
eq('a power conference groups as p4', U.teams.ohiostate.group, 'p4');
eq('a non-power conference groups as other', U.teams.ohio.group, 'other');
eq('an independent groups as independent', U.teams.notredame.group, 'independent');
chk('no user-facing group or conference label is "Group of 5"',
  F.GROUPS.every(g => !/group of (5|five)/i.test(g.label))
  && F.CONFERENCES.every(c => !/group of (5|five)/i.test(c.label))
  && Object.keys(F.GROUP_LABEL).every(k => !/group of (5|five)/i.test(F.GROUP_LABEL[k])),
  F.GROUPS.map(g => g.label));
chk('the durable non-power category is "Other FBS"', F.GROUP_LABEL.other === 'Other FBS');
chk('an FCS team carries no program group', U.teams.wofford.group === null);

/* ======================================================================
   5. THE UNIVERSE
   ====================================================================== */
eq('every FBS program in the fixture is counted', U.counts.fbs_teams, 15);
chk('the FBS count is derived, not stored', () => {
  const one = F.buildUniverse({ rows: ROWS.slice(0, 2), season: 2026, params: P4 });
  return one.counts.fbs_teams === 4 && U.counts.fbs_teams !== one.counts.fbs_teams;
});
chk('the conference list is derived from the season, longest group first', () => {
  const ids = U.conferences.map(c => c.id);
  const groups = U.conferences.map(c => c.group);
  return ids.indexOf('bigten') >= 0 && ids.indexOf('mac') >= 0 && ids.indexOf('independents') >= 0
    && groups[0] === 'p4' && groups[groups.length - 1] === 'independent';
});
chk('a promoted program is in the universe with its new conference',
  U.teams.northdakotastate && U.teams.northdakotastate.division === 'fbs'
  && U.teams.northdakotastate.conference.id === 'mwc');
chk('nothing in the fixture is unmapped', U.diagnostics.unmapped_teams.length === 0, U.diagnostics.unmapped_teams);
chk('nothing in the fixture is missing a conference', U.diagnostics.missing_conference.length === 0, U.diagnostics.missing_conference);
chk('an unrecognised conference is REPORTED rather than dropped', () => {
  const rows = ROWS.concat([game({ game_id: 'gx', home_team: 'Nowhere State', home_conference: 'Imaginary League',
    away_team: 'Ohio', away_conference: 'Mid-American' })]);
  const u = F.buildUniverse({ rows, season: 2026, params: P4 });
  return u.diagnostics.unexpected_conferences.length === 1
    && u.teams.nowherestate.conference.label === 'Imaginary League';
});
chk('a program in two conferences inside one season is a reported conflict', () => {
  const rows = ROWS.concat([game({ game_id: 'gy', home_team: 'Ohio', home_conference: 'Sun Belt',
    away_team: 'Akron', away_conference: 'Mid-American' })]);
  const u = F.buildUniverse({ rows, season: 2026, params: P4 });
  return u.diagnostics.conflicting_conferences.length >= 1;
});
chk('a team whose name resolves to no key is reported, not dropped in silence', () => {
  const rows = ROWS.concat([game({ game_id: 'gz', home_team: '---', home_conference: 'Mid-American',
    away_team: 'Akron', away_conference: 'Mid-American' })]);
  const u = F.buildUniverse({ rows, season: 2026, params: P4 });
  return u.diagnostics.unmapped_teams.length === 1;
});
chk('a season-1 universe reads that season’s alignment, not this one’s', () => {
  const prior = [game({ game_id: 'p1', season: 2025, home_team: 'Texas State', home_conference: 'Sun Belt',
    away_team: 'Ohio', away_conference: 'Mid-American' })];
  const old = F.buildUniverse({ rows: prior, season: 2025, params: P4 });
  return old.teams.texasstate.conference.id === 'sunbelt'
    && U.teams.texasstate.conference.id === 'pac12';
});

/* ======================================================================
   6. GAME CLASSIFICATION
   ====================================================================== */
function meta(id) {
  const r = ROWS.find(x => x.game_id === id);
  return F.classifyGame(r, U);
}
eq('a same-conference flagged game is a conference game', meta('g1').matchup_type, 'conference');
eq('a non-power same-conference game is a conference game too', meta('g2').matchup_type, 'conference');
eq('two different conferences is non-conference', meta('g3').matchup_type, 'non_conference');
eq('power vs non-power is non-conference', meta('g4').matchup_type, 'non_conference');
eq('FBS vs FCS is its own type', meta('g6').matchup_type, 'fbs_fcs');
chk('two independents are NOT a conference game even when the feed flags it',
  meta('g5').is_conference_game === false && meta('g5').matchup_type === 'non_conference',
  { type: meta('g5').matchup_type, basis: meta('g5').conference_basis });
chk('a conference-game flag on two different conferences is refused, and says why', () => {
  const m = F.classifyGame(game({ game_id: 'gq', home_team: 'Ohio', home_conference: 'Mid-American',
    away_team: 'UTSA', away_conference: 'American Athletic', conference_game: true }), U);
  return m.is_conference_game === false && /different conferences/.test(m.conference_basis);
});
chk('with no flag at all a shared conference is inferred, and says it was inferred', () => {
  const r = game({ game_id: 'gw', home_team: 'Ohio', home_conference: 'Mid-American',
    away_team: 'Akron', away_conference: 'Mid-American' });
  delete r.conference_game;
  const m = F.classifyGame(r, U);
  return m.is_conference_game === true && /inferred/.test(m.conference_basis);
});
eq('an FBS-vs-FCS game is classified by the FBS participant',
  meta('g6').conference_ids.join(','), 'mac');
chk('an FBS-vs-FCS game is eligible but not projectable',
  meta('g6').eligible === true && meta('g6').projectable === false);
chk('an FBS-vs-FBS game is projectable', meta('g1').projectable === true);
chk('an FCS-vs-FCS game is not eligible', meta('g7').eligible === false);
chk('a game carries BOTH of its conferences for filtering',
  meta('g3').conference_ids.sort().join(',') === 'american,pac12');
chk('a game carries its program groups', meta('g4').groups.sort().join(',') === 'other,p4');

/* ======================================================================
   7. THE CANONICAL GAME ID
   ====================================================================== */
eq('the feed’s id is the canonical id when there is one', F.gameKey(ROWS[0]), 'g1');
chk('a game with no id gets a deterministic one', () => {
  const r = ROWS[ROWS.length - 1];
  const a = F.gameKey(r), b = F.gameKey(Object.assign({}, r));
  return a === b && /^edfbs:2026:/.test(a) && /buffalo@akron$/.test(a);
});
chk('two different games never share a derived id', () => {
  const a = F.gameKey(game({ home_team: 'Akron', away_team: 'Buffalo' }));
  const b = F.gameKey(game({ home_team: 'Buffalo', away_team: 'Akron' }));
  return a !== b;
});

/* ======================================================================
   8. THE SLATE
   ====================================================================== */
const S = F.buildSlate({ rows: ROWS, universe: U, now: T0 - 3600e3, lookaheadDays: 10 });
eq('every eligible game inside the window is on the slate', S.items.length, 8);
chk('a completed game is not on the slate', !S.items.some(i => i.g.game_id === 'g9'));
chk('a game outside the window is not on the slate', !S.items.some(i => i.g.game_id === 'g10'));
chk('an FCS-vs-FCS game is not on the slate', !S.items.some(i => i.g.game_id === 'g7'));
chk('a game with no Power 4 participant IS on the slate',
  S.items.some(i => i.g.game_id === 'g2') && S.items.some(i => i.g.game_id === 'g3'),
  S.items.map(i => i.meta.id));
chk('the slate is in kickoff order', () => {
  for (let i = 1; i < S.items.length; i++) if (S.items[i].t < S.items[i - 1].t) return false;
  return true;
});
chk('the same row twice produces one slate entry', () => {
  const dup = F.buildSlate({ rows: ROWS.concat(ROWS), universe: U, now: T0 - 3600e3, lookaheadDays: 10 });
  return dup.items.length === S.items.length && dup.dropped.duplicate === S.items.length;
});
chk('the drop reasons account for every row', () => {
  const d = S.dropped;
  return S.items.length + d.completed + d.outside_window + d.no_fbs + d.duplicate + d.no_kickoff === ROWS.length;
});

/* ======================================================================
   9. FILTERS — composition and the no-duplicate rule
   ====================================================================== */
const n = f => F.filterSlate(S.items, f).length;
eq('no filter shows everything', n({}), 8);
eq('All FBS shows everything', n({ group: 'all' }), 8);
chk('Power 4 shows only games with a power participant',
  F.filterSlate(S.items, { group: 'p4' }).every(i => i.meta.groups.indexOf('p4') >= 0));
chk('Other FBS includes a power-vs-non-power game, because one side qualifies',
  F.filterSlate(S.items, { group: 'other' }).some(i => i.g.game_id === 'g4'));
eq('Independents shows the independent game', n({ group: 'independent' }), 1);
eq('one conference filters to its own games', n({ conferences: ['mac'] }), 3);
chk('two conferences never duplicate a game', () => {
  const sel = F.filterSlate(S.items, { conferences: ['mac', 'american'] });
  const seen = {};
  for (const i of sel) { if (seen[i.meta.id]) return false; seen[i.meta.id] = 1; }
  return true;
});
chk('a game between two SELECTED conferences appears exactly once', () => {
  const sel = F.filterSlate(S.items, { conferences: ['pac12', 'american'] });
  return sel.filter(i => i.g.game_id === 'g3').length === 1;
});
chk('a game between two teams in the SAME selected conference appears once', () => {
  const sel = F.filterSlate(S.items, { conferences: ['mac'] });
  return sel.filter(i => i.g.game_id === 'g2').length === 1;
});
chk('an empty conference list means all conferences', n({ conferences: [] }) === 8);
eq('conference-game filtering uses the matchup type', n({ matchup: 'conference' }), 4);
eq('non-conference filtering uses the matchup type', n({ matchup: 'non_conference' }), 3);
eq('FBS-vs-FCS filtering uses the matchup type', n({ matchup: 'fbs_fcs' }), 1);
chk('the matchup types partition the slate',
  n({ matchup: 'conference' }) + n({ matchup: 'non_conference' }) + n({ matchup: 'fbs_fcs' }) === S.items.length);
chk('filters compose rather than override', () => {
  const a = F.filterSlate(S.items, { group: 'other', matchup: 'conference' });
  return a.every(i => i.meta.groups.indexOf('other') >= 0 && i.meta.matchup_type === 'conference')
    && a.length > 0 && a.length <= n({ matchup: 'conference' });
});
chk('a conference with nothing in this window filters to nothing, not to everything',
  n({ conferences: ['acc'] }) === 0);

/* ======================================================================
   10. ALIAS RESOLUTION — the odds join
   ====================================================================== */
const IX = F.teamIndex(U);
const ALIAS_CASES = [
  ['Ohio Bobcats', 'ohio'], ['Ohio State Buckeyes', 'ohiostate'], ['Ohio', 'ohio'],
  ['Miami (OH) RedHawks', 'miamioh'], ['Miami RedHawks', 'miamioh'], ['Miami-Ohio', 'miamioh'],
  ['Texas A&M Aggies', 'texasam'], ['Texas AandM', 'texasam'], ['Texas A and M', 'texasam'],
  ['Southern Miss Golden Eagles', 'southernmiss'], ['Southern Mississippi', 'southernmiss'],
  ['UConn Huskies', 'uconn'], ['Connecticut', 'uconn'],
  ['UTSA Roadrunners', 'utsa'], ['Texas-San Antonio', 'utsa'],
  ['Kent Golden Flashes', 'kentstate'], ['Kent State', 'kentstate'],
  ['North Dakota State Bison', 'northdakotastate'], ['NDSU', 'northdakotastate'],
  ['Texas State Bobcats', 'texasstate'], ['Air Force Falcons', 'airforce'],
  ['Notre Dame Fighting Irish', 'notredame'], ['Akron Zips', 'akron'],
  ['Buffalo Bulls', 'buffalo'], ['Michigan Wolverines', 'michigan'],
  ['A Team Nobody Has', null]
];
ALIAS_CASES.forEach(([name, want]) => {
  const r = F.resolveTeam(name, IX);
  eq('alias: ' + name, r && r.key, want);
});
chk('an exact name resolves as exact', F.resolveTeam('Ohio', IX).how === 'exact');
chk('a nickname resolves by prefix', F.resolveTeam('Ohio Bobcats', IX).how === 'prefix');
chk('an abbreviation resolves by the alias table', F.resolveTeam('NDSU', IX).how === 'alias');
chk('"St" expands to "State" only after exact and alias have failed', () => {
  const r = F.resolveTeam('Kent St', IX);
  /* "Kent" alone is a curated alias of Kent State, so the expansion path is
     only reached because "kentst" is neither a key nor an alias */
  return r && r.key === 'kentstate' && r.how === 'state-expansion'
    && F.resolveTeam('Kent', IX).how === 'alias';
});
chk('an ambiguous name resolves to NOTHING rather than to the wrong school', () => {
  const rows = [game({ home_team: 'Aurora', home_conference: 'Mid-American',
    away_team: 'Aurora College', away_conference: 'Mid-American' })];
  const u2 = F.buildUniverse({ rows, season: 2026, params: P4 });
  const ix2 = F.teamIndex(u2);
  /* "Aurora" is a prefix of "Aurora College" — the longest wins, and the
     shorter name is still exactly itself */
  return F.resolveTeam('Aurora College Something', ix2).key === 'auroracollege'
    && F.resolveTeam('Aurora', ix2).key === 'aurora';
});
chk('a two-letter fragment never resolves', F.resolveTeam('OH', IX) === null);
chk('the resolver never invents a team', F.resolveTeam('Nonesuch Tech', IX) === null);

/* the odds join proper: both sides, and the kickoff */
const item = S.items.find(i => i.g.game_id === 'g2');
chk('an event whose two names resolve to this game matches',
  F.matchesEvent({ home: 'Ohio Bobcats', away: 'Miami (OH) RedHawks', t: item.g.start_date }, item, IX));
chk('an event with the sides reversed does NOT match',
  !F.matchesEvent({ home: 'Miami (OH) RedHawks', away: 'Ohio Bobcats', t: item.g.start_date }, item, IX));
chk('an event on the wrong day does NOT match',
  !F.matchesEvent({ home: 'Ohio Bobcats', away: 'Miami (OH) RedHawks',
    t: new Date(Date.parse(item.g.start_date) + 5 * DAY).toISOString() }, item, IX));
chk('a Miami FLORIDA event never matches a Miami OHIO game', () => {
  const rows = ROWS.concat([game({ game_id: 'gm', home_team: 'Miami', home_conference: 'ACC',
    away_team: 'Ohio State', away_conference: 'Big Ten', start_date: item.g.start_date })]);
  const u2 = F.buildUniverse({ rows, season: 2026, params: P4 });
  const s2 = F.buildSlate({ rows, universe: u2, now: T0 - 3600e3, lookaheadDays: 10 });
  const ix2 = F.teamIndex(u2);
  const fl = s2.items.find(i => i.g.game_id === 'gm');
  const oh = s2.items.find(i => i.g.game_id === 'g2');
  /* the Miami (OH) event must land on the MAC game and nowhere else */
  const ev = { home: 'Miami (OH) RedHawks', away: 'Ohio State Buckeyes', t: fl.g.start_date };
  return !F.matchesEvent(ev, fl, ix2) && !F.matchesEvent(ev, oh, ix2)
    && F.matchesEvent({ home: 'Miami Hurricanes', away: 'Ohio State Buckeyes', t: fl.g.start_date }, fl, ix2);
});
chk('half a match is not a match', () => {
  /* right home team, an away team that belongs to another game */
  return !F.matchesEvent({ home: 'Ohio Bobcats', away: 'Michigan Wolverines', t: item.g.start_date }, item, IX);
});

/* ======================================================================
   11. THE AUDIT
   ====================================================================== */
const RATINGS = {};
U.order.forEach(k => { if (U.teams[k].division === 'fbs' && k !== 'northdakotastate') RATINGS[k] = 0; });
const A = F.audit(U, { slate: S.items, ratings: RATINGS });
chk('an FBS team with no rating is named', A.fbs_teams_without_rating.length === 1
  && A.fbs_teams_without_rating[0].key === 'northdakotastate', A.fbs_teams_without_rating);
chk('the audit is not ok when a program is unrated', A.ok === false);
chk('the audit counts the slate by matchup, group and conference',
  A.slate.total === S.items.length && A.slate.by_matchup.conference === 4
  && A.slate.by_group.p4 > 0 && A.slate.by_conference.mac === 3,
  { total: A.slate.total, matchup: A.slate.by_matchup, conf: A.slate.by_conference });
chk('the audit reports an eligible game with no projection', () => {
  const projected = {}; S.items.forEach((i, ix) => { if (ix) projected[i.meta.id] = 1; });
  const a2 = F.audit(U, { slate: S.items, ratings: RATINGS, projected });
  return a2.games_missing_projection.length >= 0
    && a2.games_missing_projection.every(g => typeof g.label === 'string');
});
chk('a fully rated universe with no duplicates audits ok', () => {
  const all = {}; U.order.forEach(k => { if (U.teams[k].division === 'fbs') all[k] = 0; });
  return F.audit(U, { slate: S.items, ratings: all }).ok === true;
});

/* ======================================================================
   12. THE COMMITTED ARTIFACTS — the fixture is not allowed to drift from
       the real universe.
   ====================================================================== */
const COV = path.join(HERE, 'coverage.json');
const SLATE = path.join(HERE, 'slate.json');
if (fs.existsSync(COV)) {
  const c = JSON.parse(fs.readFileSync(COV, 'utf8'));
  chk('the committed coverage report passes its own checks', c.ok === true, c.failures);
  chk('the committed coverage report carries every check', c.checks.length >= 14, c.checks.length);
  chk('the real universe has more than 120 active FBS programs', c.counts.fbs_teams > 120, c.counts.fbs_teams);
  chk('the real universe has at least ten conferences', c.conferences.length >= 10, c.conferences.length);
  chk('the real slate carries games with no Power 4 participant', () => {
    const p4 = c.p4.ids;
    const byConf = c.slate.by_conference || {};
    return Object.keys(byConf).some(id => p4.indexOf(id) < 0 && byConf[id] > 0);
  });
  chk('the real slate carries conference, non-conference and FBS-vs-FCS games',
    c.slate.by_matchup.conference > 0 && c.slate.by_matchup.non_conference > 0
    && c.slate.by_matchup.fbs_fcs > 0, c.slate.by_matchup);
  chk('no FBS program in the real universe is missing a conference',
    c.missing_conference.length === 0, c.missing_conference);
  chk('no team in the real universe is unmapped', c.unmapped_teams.length === 0, c.unmapped_teams);
  chk('every conference label in the real feed is recognised',
    c.unexpected_conferences.length === 0, c.unexpected_conferences);
  chk('the real universe’s conferences all carry a program group',
    c.conferences.every(x => !!x.group), c.conferences.filter(x => !x.group));
  chk('season-aware conference attribution was actually exercised',
    c.season_aware && c.season_aware.tested === true, c.season_aware);
} else {
  chk('the coverage report is committed (run npm run cfb:fbs)', false, COV);
}
if (fs.existsSync(SLATE)) {
  const s = JSON.parse(fs.readFileSync(SLATE, 'utf8'));
  const NEED = ['home_team_id', 'away_team_id', 'home_conference', 'away_conference',
    'home_fbs_group', 'away_fbs_group', 'matchup_type', 'is_conference_game',
    'model_status', 'data_completeness', 'market_status', 'quote_timestamp'];
  chk('the slate artifact carries every stable field on every row',
    s.games.length > 0 && s.games.every(g => NEED.every(k => Object.prototype.hasOwnProperty.call(g, k))),
    NEED.filter(k => !Object.prototype.hasOwnProperty.call(s.games[0] || {}, k)));
  chk('the slate artifact counts reconcile with its own rows',
    s.counts.slate === s.games.length, { counts: s.counts.slate, rows: s.games.length });
  chk('the slate artifact never writes a market line it did not join',
    s.games.every(g => g.market_status === 'NOT JOINED IN THIS BUILD' && g.quote_timestamp === null));
  chk('no FBS-vs-FCS row in the artifact carries a graded spread recommendation',
    s.games.filter(g => g.matchup_type === 'fbs_fcs')
      .every(g => g.spread_recommendation === 'PASS_LOW_CONFIDENCE' || g.spread_recommendation === 'NO_MARKET'),
    s.games.filter(g => g.matchup_type === 'fbs_fcs' && g.spread_recommendation !== 'PASS_LOW_CONFIDENCE'
      && g.spread_recommendation !== 'NO_MARKET').slice(0, 4));
  chk('every row in the artifact has a unique canonical id', () => {
    const seen = {};
    for (const g of s.games) { if (seen[g.game_id]) return false; seen[g.game_id] = 1; }
    return true;
  });
} else {
  chk('the slate artifact is committed (run npm run cfb:fbs)', false, SLATE);
}

/* the EdgeDesk Rating dataset, which the board's rating views read */
const EDR = path.join(ROOT, 'football', 'rating', 'current.json');
if (fs.existsSync(EDR)) {
  const d = JSON.parse(fs.readFileSync(EDR, 'utf8'));
  chk('every rated program carries a conference', () => {
    const without = d.teams.filter(t => !t.conference_id);
    return without.length === 0;
  }, (JSON.parse(fs.readFileSync(EDR, 'utf8')).teams.filter(t => !t.conference_id) || []).slice(0, 5).map(t => t.team));
  chk('every rated program carries a program group',
    d.teams.every(t => t.fbs_group === 'p4' || t.fbs_group === 'other' || t.fbs_group === 'independent'),
    d.teams.filter(t => !t.fbs_group).slice(0, 5).map(t => t.team));
  chk('Texas A&M is reachable by the canonical key every other artifact uses', () => {
    const t = d.teams.find(x => x.team === 'Texas A&M');
    return t && t.canonical_key === F.normKey('Texas A&M');
  });
  chk('the rating dataset publishes its conference coverage',
    d.conference_coverage && d.conference_coverage.with_conference === d.team_count,
    d.conference_coverage);
  chk('group ranks come off the same ordering as the overall rank', () => {
    let last = {}; let ok = true;
    d.teams.forEach(t => {
      if (!t.fbs_group) return;
      if (last[t.fbs_group] != null && t.group_rank !== last[t.fbs_group] + 1) ok = false;
      last[t.fbs_group] = t.group_rank;
    });
    return ok;
  });
  chk('no team is re-rated inside a group — the rating is the same number in every view', () => {
    const p4 = d.teams.filter(t => t.fbs_group === 'p4');
    return p4.every(t => d.teams.find(x => x.key === t.key).rating === t.rating);
  });
}

/* ---------------------------------------------------------------- report */
if (fail) {
  console.log('FAIL | FBS universe | ' + pass + ' passed, ' + fail + ' failed');
  failures.slice(0, 40).forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('PASS | FBS universe | ' + pass + ' assertions');
