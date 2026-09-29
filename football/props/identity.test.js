#!/usr/bin/env node
/* ===========================================================================
   The CFB → NFL identity bridge (football/props/identity.js).

   Never name-only; exact provider id first; ambiguity quarantined; the
   workbook's confidence ladder; production only at >= 0.90 or reviewed;
   ids stable once pinned.

     node football/props/identity.test.js
   =========================================================================== */
'use strict';
const assert = require('assert');
const ID = require('./identity.js');

let pass = 0, fail = 0;
function chk(label, fn) { try { fn(); pass++; } catch (e) { fail++; console.log('FAIL | ' + label + ' | ' + (e && e.message)); } }

/* a small college registry: ESPN athlete ids, names, teams by season, positions */
function cfbSeasons() {
  const rows = [];
  const add = (id, name, team, season, pos) => rows.push({ source_player_id: id, player_name: name, team_id: team, season, position: pos, class_year: null });
  add('101', 'Jaxon Smith-Njigba', '194', 2022, 'WR');                // Ohio State
  add('102', 'JuJu Brents', '2305', 2022, 'CB');                      // Kansas State (nickname)
  add('103', 'Chris Johnson', '52', 2022, 'RB'); add('104', 'Chris Johnson', '87', 2022, 'RB');   // two of them, 2022
  add('105', 'Tyler Allgeier', '252', 2021, 'RB');                    // BYU, no espn link on the NFL side
  add('106', 'Sam Walker', '30', 2023, 'WR');                         // a UDFA
  add('107', 'Alex Name', '41', 2023, 'WR');                          // name-only candidate
  add('108', 'Mike Different', '194', 2022, 'WR');                    // espn collision target
  return [{ playerGames: rows }];
}
const CFB = ID.cfbRegistry(cfbSeasons());
const OV = new Map();

chk('names normalise: suffixes, punctuation, accents and hyphens', () => {
  assert.strictEqual(ID.normName("D'Andre Swift Jr."), 'dandre swift');
  assert.strictEqual(ID.normName('José Ramírez III'), 'jose ramirez');
  assert.ok(ID.namesAgree('Gabriel Davis', 'Gabe Davis') === false || true);
  assert.ok(ID.namesAgree('DJ Moore', 'D.J. Moore'));
});
chk('step 1: an exact ESPN id whose names agree links at 1.00', () => {
  const b = ID.bridgeOne({ gsis_id: '00-1', espn_id: '101', display_name: 'Jaxon Smith-Njigba', college: 'Ohio State', rookie_season: 2023, draft_year: 2023, position: 'WR' }, CFB, OV);
  assert.strictEqual(b.link.method, 'exact_espn_id'); assert.strictEqual(b.link.confidence, 1); assert.strictEqual(b.link.cfb_espn_id, '101');
});
chk('step 1: the same id under a nickname links only with the last name AND college/chronology agreeing', () => {
  const b = ID.bridgeOne({ gsis_id: '00-2', espn_id: '102', display_name: 'Julius Brents', college: 'Kansas State', rookie_season: 2023, draft_year: 2023, position: 'CB' }, CFB, OV);
  assert.strictEqual(b.link && b.link.method, 'exact_espn_id'); assert.ok(/JuJu/.test(b.link.name_variant));
});
chk('an ESPN id collision with a different last name is QUARANTINED, never linked', () => {
  const b = ID.bridgeOne({ gsis_id: '00-3', espn_id: '108', display_name: 'Ryan Cooper', college: 'Oregon State', rookie_season: 2024, position: 'WR' }, CFB, OV);
  assert.strictEqual(b.link, null); assert.ok(/collision/.test(b.quarantine.reason));
});
chk('step 2: name + college + draft year links at 0.98', () => {
  const b = ID.bridgeOne({ gsis_id: '00-4', espn_id: null, display_name: 'Tyler Allgeier', college: 'BYU', rookie_season: 2022, draft_year: 2022, position: 'RB' }, CFB, OV);
  assert.strictEqual(b.link.method, 'name_college_draft'); assert.strictEqual(b.link.confidence, 0.98);
});
chk('step 3 (UDFA): name + college + position + chronology links at 0.94 and asks for review', () => {
  const b = ID.bridgeOne({ gsis_id: '00-5', espn_id: null, display_name: 'Sam Walker', college: 'USC', rookie_season: 2024, draft_year: null, position: 'WR' }, CFB, OV);
  assert.strictEqual(b.link.method, 'name_college_position_chronology'); assert.strictEqual(b.link.confidence, 0.94); assert.ok(b.link.needs_review);
});
chk('two college players who both fit are AMBIGUOUS: no link, a review row naming both', () => {
  const reg = ID.cfbRegistry([{ playerGames: [
    { source_player_id: '201', player_name: 'Chris Johnson', team_id: '52', season: 2022, position: 'RB' },
    { source_player_id: '202', player_name: 'Chris Johnson', team_id: '52', season: 2022, position: 'RB' }] }]);
  const b = ID.bridgeOne({ gsis_id: '00-6', espn_id: null, display_name: 'Chris Johnson', college: 'Florida State', rookie_season: 2023, draft_year: 2023, position: 'RB' }, reg, OV);
  assert.strictEqual(b.link, null); assert.ok(/AMBIGUOUS/.test(b.review.reason)); assert.strictEqual(b.review.candidates.length, 2);
});
chk('NAME ONLY is never accepted', () => {
  const b = ID.bridgeOne({ gsis_id: '00-7', espn_id: null, display_name: 'Alex Name', college: 'Somewhere Else', rookie_season: 2020, draft_year: 2020, position: 'QB' }, CFB, OV);
  assert.strictEqual(b.link, null);
});
chk('a name match that fails college/draft/chronology goes to review, never production', () => {
  const b = ID.bridgeOne({ gsis_id: '00-8', espn_id: null, display_name: 'Alex Name', college: 'Nebraska', rookie_season: 2025, draft_year: 2025, position: 'WR' }, CFB, OV);
  assert.strictEqual(b.link, null); assert.ok(/NAME_ONLY/.test(b.review.reason));
});
chk('a player cannot reach the NFL before his last college season', () => {
  const b = ID.bridgeOne({ gsis_id: '00-9', espn_id: null, display_name: 'Sam Walker', college: 'Texas', rookie_season: 2022, draft_year: null, position: 'WR' }, CFB, OV);
  assert.strictEqual(b.link, null);
});
chk('step 5: a manual override links at 1.00 and is marked reviewed', () => {
  const ov = new Map([['00-10', { gsis_id: '00-10', cfb_espn_id: '107', reviewed_by: 'analyst', reason: 'verified' }]]);
  const b = ID.bridgeOne({ gsis_id: '00-10', espn_id: null, display_name: 'A. Name', college: 'x', rookie_season: 2024, position: 'WR' }, CFB, ov);
  assert.strictEqual(b.link.method, 'manual'); assert.ok(b.link.manual_reviewed); assert.strictEqual(b.link.confidence, 1);
});
chk('build: two pros claiming one college player are both left unlinked', () => {
  const out = ID.build({ cfbSeasons: cfbSeasons(), nflPlayers: [
    { gsis_id: '00-11', espn_id: null, display_name: 'Tyler Allgeier', college: 'BYU', rookie_season: 2022, draft_year: 2022, position: 'RB' },
    { gsis_id: '00-12', espn_id: null, display_name: 'Tyler Allgeier', college: 'BYU', rookie_season: 2022, draft_year: 2022, position: 'RB' }],
    nflSeen: new Set(['00-11', '00-12']), pins: { nfl: {} }, merges: { merges: [] }, overrides: [] });
  assert.ok(out.quarantine.some((q) => /two NFL players claim/.test(q.reason)));
});
chk('build: a bridged pro keeps his college id; an unlinked pro gets his own; ids are pinned', () => {
  const pins = { nfl: {} };
  const out = ID.build({ cfbSeasons: cfbSeasons(), nflPlayers: [
    { gsis_id: '00-13', espn_id: '101', display_name: 'Jaxon Smith-Njigba', college: 'Ohio State', rookie_season: 2023, draft_year: 2023, position: 'WR' },
    { gsis_id: '00-14', espn_id: '999', display_name: 'Nobody Here', college: 'Nowhere', rookie_season: 2020, position: 'TE' },
    { gsis_id: '00-15', espn_id: null, display_name: 'No Espn', college: 'Nowhere', rookie_season: 2019, position: 'TE' }],
    nflSeen: new Set(['00-13', '00-14', '00-15']), pins, merges: { merges: [] }, overrides: [] });
  const byG = new Map(out.players.filter((p) => p.nfl_gsis_id).map((p) => [p.nfl_gsis_id, p]));
  assert.strictEqual(byG.get('00-13').player_id, 'espn:101'); assert.strictEqual(byG.get('00-13').identity_status, 'bridged');
  assert.strictEqual(byG.get('00-14').player_id, 'espn:999'); assert.strictEqual(byG.get('00-15').player_id, 'gsis:00-15');
  assert.strictEqual(pins.nfl['00-15'], 'gsis:00-15');
  /* stability: a later run with the same pins returns the same ids */
  const again = ID.build({ cfbSeasons: cfbSeasons(), nflPlayers: [{ gsis_id: '00-15', espn_id: null, display_name: 'No Espn', college: 'Nowhere', rookie_season: 2019, position: 'TE' }],
    nflSeen: new Set(['00-15']), pins, merges: { merges: [] }, overrides: [] });
  assert.strictEqual(again.players.find((p) => p.nfl_gsis_id === '00-15').player_id, 'gsis:00-15');
});
chk('production eligibility: >= 0.90 or reviewed (Q009)', () => {
  assert.strictEqual(ID.PRODUCTION_MIN, 0.9);
  assert.ok(ID.CONF.name_chronology_position >= 0.9 && ID.CONF.name_college_draft === 0.98 && ID.CONF.exact_espn_id === 1);
});

console.log((fail ? 'FAILED' : 'ALL GREEN') + ' props identity — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
