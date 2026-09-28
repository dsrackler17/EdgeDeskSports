#!/usr/bin/env node
/* ===========================================================================
   Canonical team and event identity (lib/football_identity.js).

   The 2026 college record lost its closing lines to a string comparison:
   the Collective stores "MISSISSIPP" and the odds feed says "Mississippi
   State Bulldogs". These cases pin the resolver that replaces it, and the
   last block runs it on REAL data: the Collective's committed CFB record
   (ten-character codes only, the weakest shape production holds) against
   EdgeDesk's ESPN event ledger (full names and ESPN ids). Every link is
   checked by the one fact both sides hold independently — the final score —
   so a wrong join cannot pass by agreeing with itself.

   Run: node tools/collective/football_identity.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const I = require(path.join(ROOT, 'lib', 'football_identity.js'));

let pass = 0, fail = 0;
const fails = [];
function chk(name, cond, detail) {
  if (cond) pass++;
  else { fail++; fails.push({ name, detail }); }
}

/* ---- NFL -------------------------------------------------------------- */
const nflTeams = I.NFL_TEAMS.map(t => ({ id: t[0], code: t[0], name: t[0] }));   /* stored as codes */
const NFL = I.buildRegistry('NFL', nflTeams);
[['LA', 'LAR'], ['LAR', 'LAR'], ['Los Angeles Rams', 'LAR'], ['LA Chargers', 'LAC'], ['JAC', 'JAX'],
 ['Jacksonville Jaguars', 'JAX'], ['WSH', 'WAS'], ['Washington Commanders', 'WAS'], ['Kansas City Chiefs', 'KC'],
 ['San Francisco 49ers', 'SF'], ['New York Giants', 'NYG'], ['New York Jets', 'NYJ'], ['Tampa Bay Buccaneers', 'TB'],
 ['Green Bay', 'GB'], ['OAK', 'LV'], ['Las Vegas Raiders', 'LV'], ['New England Patriots', 'NE'], ['NO', 'NO']]
  .forEach(([raw, want]) => {
    const r = I.resolveTeam(NFL, raw);
    chk(`NFL: ${raw} -> ${want}`, r.team_id === want, r);
  });
chk('NFL: "Los Angeles" alone is two teams and resolves to neither', !I.resolveTeam(NFL, 'Los Angeles').team_id);
chk('NFL: "New York" alone resolves to neither', !I.resolveTeam(NFL, 'New York').team_id);
chk('NFL: LAR never latches onto LAC', I.resolveTeam(NFL, 'LAR').team_id !== 'LAC');

/* ---- CFB, full names in the registry ------------------------------------ */
const full = ['Mississippi', 'Mississippi State', 'Miami', 'Miami (OH)', 'Ohio State', 'Ohio', 'North Carolina',
  'NC State', 'Washington', 'Washington State', 'West Virginia', 'San Jose State', 'Texas A&M', 'USC', 'Southern Miss',
  'Louisiana', 'UL Monroe', 'Georgia', 'Georgia Tech', 'Georgia Southern', 'Western Kentucky']
  .map((n, i) => ({ id: 't' + i, name: n, code: I.teamCode(n) }));
const CFB = I.buildRegistry('CFB', full);
const idOf = n => full.find(t => t.name === n).id;
[['Ole Miss Rebels', 'Mississippi'], ['Ole Miss', 'Mississippi'], ['Mississippi State Bulldogs', 'Mississippi State'],
 ['Miami Hurricanes', 'Miami'], ['Miami (FL)', 'Miami'], ['Miami (OH) RedHawks', 'Miami (OH)'], ['Miami OH', 'Miami (OH)'],
 ['Ohio St.', 'Ohio State'], ['Ohio St', 'Ohio State'], ['Ohio State Buckeyes', 'Ohio State'], ['Ohio Bobcats', 'Ohio'],
 ['North Carolina State', 'NC State'], ['NC State Wolfpack', 'NC State'], ['North Carolina Tar Heels', 'North Carolina'],
 ['San José State Spartans', 'San Jose State'], ['Texas A&M Aggies', 'Texas A&M'], ['Southern California', 'USC'],
 ['Southern Mississippi', 'Southern Miss'], ['Louisiana-Lafayette', 'Louisiana'], ['Louisiana Ragin\' Cajuns', 'Louisiana'],
 ['Louisiana-Monroe', 'UL Monroe'], ['Georgia Tech Yellow Jackets', 'Georgia Tech'], ['Georgia Bulldogs', 'Georgia'],
 ['WKU Hilltoppers', 'Western Kentucky'], ['WESTVIRGIN', 'West Virginia'], ['WASHINGTON', 'Washington']]
  .forEach(([raw, want]) => {
    const r = I.resolveTeam(CFB, raw);
    chk(`CFB: ${raw} -> ${want}`, r.team_id === idOf(want), r);
  });
const nc = I.resolveTeam(CFB, 'NORTHCAROL');
chk('CFB: NORTHCAROL exactly names North Carolina (its own code), never NC State',
  nc.team_id === idOf('North Carolina'), nc);
const trunc = I.buildRegistry('CFB', [{ id: 'a', name: 'North Carolina', code: 'NCAR' }, { id: 'b', name: 'North Carolina Central', code: 'NCCU' }]);
const amb = I.resolveTeam(trunc, 'NORTHCAROL');
chk('CFB: a ten-character truncation shared by two schools is ambiguous, never a guess',
  amb.team_id === null && amb.reason === 'ambiguous_truncation', amb);
chk('CFB: "Miami (OH)" never falls through to Miami when only Miami (FL) is held',
  I.resolveTeam(I.buildRegistry('CFB', [{ id: 'm', name: 'Miami', code: 'MIAMI' }]), 'Miami (OH) RedHawks').team_id === null);
chk('CFB: "Mississippi State" never falls through to Mississippi',
  I.resolveTeam(I.buildRegistry('CFB', [{ id: 'm', name: 'Mississippi', code: 'MISSISSIPP' }]), 'Mississippi State Bulldogs').team_id === null);

/* ---- legacy code-only teams (production's weak shape) --------------------- */
const legacy = I.buildRegistry('CFB', [{ id: 'MISSISSIPP', code: 'MISSISSIPP', name: 'MISSISSIPP' },
  { id: 'MISSISSIP2', code: 'MISSISSIP2', name: 'MISSISSIP2' }, { id: 'OHIO', code: 'OHIO', name: 'OHIO' },
  { id: 'SANJOSESTA', code: 'SANJOSESTA', name: 'SANJOSESTA' }]);
chk('legacy: a short code is the whole name (OHIO <- "Ohio Bobcats")', I.resolveTeam(legacy, 'Ohio Bobcats').team_id === 'OHIO');
const ms1 = I.resolveTeam(legacy, 'Mississippi State', ['Mississippi State', 'Ole Miss', 'Mississippi', 'Auburn']);
chk('legacy: a code AT the cut is refused when a rival school on the same slate clips to it',
  ms1.team_id === null && ms1.reason === 'ambiguous_code', ms1);
const ms2 = I.resolveTeam(legacy, 'Mississippi State', ['Mississippi State', 'Auburn']);
chk('legacy: the same code is taken, labelled weak, when no rival plays that day',
  ms2.team_id === 'MISSISSIPP' && ms2.method === 'code_truncated', ms2);
chk('legacy: an accented name reaches its folded code (San José State -> SANJOSESTA)',
  I.resolveTeam(legacy, 'San José State').team_id === 'SANJOSESTA');

/* ---- events ------------------------------------------------------------- */
const games = [
  { game_id: 'g1', sport: 'NFL', season: 2026, home_team_id: 'KC', away_team_id: 'DEN', kickoff_at: '2026-09-15T00:15:00Z', external_ref: 'espn:401' },
  { game_id: 'g2', sport: 'NFL', season: 2026, home_team_id: 'LAR', away_team_id: 'SF', kickoff_at: '2026-09-11T00:35:00Z' },
  { game_id: 'g3', sport: 'NFL', season: 2026, home_team_id: 'NYG', away_team_id: 'DAL', kickoff_at: '2026-09-14T00:20:00Z' },
];
const e = (o) => Object.assign({ source: 'collective_odds', sport: 'NFL', season: 2026 }, o);
let r = I.matchEvent(NFL, e({ source_event_id: 'x', provider_ref: '401', home_name: 'Nobody', away_name: 'Nobody', kickoff_at: '2026-09-20T00:00:00Z' }), games);
chk('event: the provider id wins over everything else', r.game_id === 'g1' && r.method === 'provider_id', r);
r = I.matchEvent(NFL, e({ source_event_id: 'y', home_name: 'Los Angeles Rams', away_name: 'San Francisco 49ers', kickoff_at: '2026-09-11T00:35:00Z' }), games);
chk('event: team ids and kickoff', r.game_id === 'g2' && r.method === 'teams_kickoff' && r.orientation === 'same', r);
r = I.matchEvent(NFL, e({ source_event_id: 'z', home_name: 'San Francisco 49ers', away_name: 'LA', kickoff_at: '2026-09-11T00:35:00Z' }), games);
chk('event: a neutral-site listing with home and away swapped links, marked swapped',
  r.game_id === 'g2' && r.orientation === 'swapped', r);
r = I.matchEvent(NFL, e({ source_event_id: 'w', home_name: 'NYG', away_name: 'DAL', kickoff_at: '2026-09-14T03:20:00Z' }), games);
chk('event: a kickoff that moved three hours still links', r.game_id === 'g3', r);
r = I.matchEvent(NFL, e({ source_event_id: 'v', home_name: 'NYG', away_name: 'DAL', kickoff_at: '2026-09-18T00:20:00Z' }), games);
chk('event: a kickoff four days away is a different fixture, reported as such',
  !r.game_id && r.reason === 'kickoff_out_of_tolerance', r);
r = I.matchEvent(NFL, e({ source_event_id: 'u', home_name: 'Somebody', away_name: 'DAL', kickoff_at: '2026-09-14T00:20:00Z' }), games);
chk('event: an unresolvable team is logged with its side and reason, never dropped', !r.game_id && /home_team_/.test(r.reason), r);
const batch = I.linkEvents(NFL, [
  e({ source_event_id: 'd1', home_name: 'NYG', away_name: 'DAL', kickoff_at: '2026-09-14T00:20:00Z' }),
  e({ source_event_id: 'd2', home_name: 'New York Giants', away_name: 'Dallas Cowboys', kickoff_at: '2026-09-14T00:25:00Z' })], games);
chk('event: two events of one source claiming one game are reported as a conflict',
  batch.conflicts.length === 1 && batch.conflicts[0].game_id === 'g3', batch.conflicts);

/* ---- duplicate canonical games ---------------------------------------------- */
const dups = I.findDuplicateGames([
  { game_id: 'a', sport: 'CFB', season: 2026, home_team_id: 'X', away_team_id: 'Y', kickoff_at: '2026-09-12T16:00:00Z' },
  { game_id: 'b', sport: 'CFB', season: 2026, home_team_id: 'X', away_team_id: 'Y', kickoff_at: '2026-09-12T19:30:00Z', external_ref: 'espn:9' },
  { game_id: 'c', sport: 'CFB', season: 2026, home_team_id: 'X', away_team_id: 'Y', kickoff_at: '2026-11-20T19:30:00Z' }],
  { predictionCounts: { a: 3, b: 1 } });
chk('duplicates: two rows of one fixture are found; a rematch weeks later is not',
  dups.length === 1 && dups[0].duplicate_game_ids.length === 1, dups);
chk('duplicates: the canonical member is the one holding the most predictions',
  dups[0].canonical_game_id === 'a' && dups[0].duplicate_game_ids[0] === 'b');

/* ---- REAL DATA: the committed CFB record against the ESPN ledger ---------- */
(() => {
  const rd = f => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const recFile = path.join(ROOT, 'collective', 'settled', 'CFB_2026.json');
  const lab = path.join(ROOT, 'football', 'cfb_lab', 'ledger', '2026');
  if (!fs.existsSync(recFile) || !fs.existsSync(lab)) { chk('real data present', false); return; }
  const rec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
  const rgames = Object.entries(rec.games).filter(([, g]) => Date.parse(g.kickoff_at) < Date.parse('2026-09-28T00:00:00Z'))
    .map(([id, g]) => ({ game_id: id, sport: 'CFB', season: 2026, home_team_id: g.home, away_team_id: g.away,
      kickoff_at: g.kickoff_at, home_score: g.home_score, away_score: g.away_score }));
  const codes = new Set(); rgames.forEach(g => { codes.add(g.home_team_id); codes.add(g.away_team_id); });
  const reg = I.buildRegistry('CFB', [...codes].map(c => ({ id: c, code: c, name: c })));
  const ev = new Map();
  ['quotes', 'predictions'].forEach(d => fs.readdirSync(path.join(lab, d)).forEach(f =>
    rd(path.join(lab, d, f)).forEach(q => {
      if (!ev.has(q.game_id) && q.home_team) ev.set(q.game_id, { source: 'espn', source_event_id: q.game_id, sport: 'CFB',
        season: 2026, home_name: q.home_team, away_name: q.away_team, kickoff_at: q.kickoff_ts });
    })));
  const res = new Map(rd(path.join(lab, 'results.jsonl')).map(x => [x.game_id, x]));
  const L = I.linkEvents(reg, [...ev.values()], rgames);
  let agree = 0, disagree = 0;
  const linked = new Set();
  L.links.forEach(l => {
    linked.add(l.game_id);
    const g = rgames.find(x => x.game_id === l.game_id), s = res.get(l.source_event_id);
    if (!s) return;
    const ok = l.orientation === 'swapped'
      ? s.home_points === g.away_score && s.away_points === g.home_score
      : s.home_points === g.home_score && s.away_points === g.away_score;
    if (ok) agree++; else disagree++;
  });
  chk(`real data: every link agrees on the final score (${agree} agree, ${disagree} disagree)`, disagree === 0 && agree >= 230, { agree, disagree });
  chk(`real data: at least 236 of ${rgames.length} record games link to their ESPN event (got ${linked.size})`, linked.size >= 236);
  chk('real data: no two ESPN events claim one Collective game', L.conflicts.length === 0, L.conflicts);
})();

if (fail) {
  fails.forEach(f => console.log('FAIL | ' + f.name + (f.detail ? '  ' + JSON.stringify(f.detail) : '')));
  console.log(`FAILED ${pass} passed, ${fail} failed`);
  process.exit(1);
}
console.log(`ALL GREEN ${pass} passed, 0 failed`);
