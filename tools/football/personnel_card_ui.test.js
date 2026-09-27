#!/usr/bin/env node
/* ============================================================================
   THE PERSONNEL AVAILABILITY SECTION, THROUGH THE REAL FOOTBALL MODULE.

   football/personnel/personnel.test.js pins the scoring. This file pins the
   page: the FBS card and the NFL card show a compact personnel block (impact,
   confidence, key losses, unit concern, "Projection effect: not enabled"),
   the full evidence sits behind a collapsed <details>, a missing artifact
   leaves no trace, and the card around it — the model's number included — is
   byte-identical with and without it.

   Boots the module out of app.html (tools/football/_module.js).
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('./_module.js');
const ROOT = M.ROOT;
const CORE = require(path.join(ROOT, 'football', 'personnel', 'impact.js'));

let checks = 0, failures = 0;
function ok(cond, what, detail) {
  checks++; if (cond) return;
  failures++; console.error('  FAIL: ' + what + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 400)));
}
function has(s, sub, what) { ok(String(s).indexOf(sub) >= 0, what, sub); }
function lacks(s, sub, what) { ok(String(s).indexOf(sub) < 0, what, sub); }
function section(t) { console.log('\n' + t); }

const BOOT = M.boot({ probe: ['fbP4Card', 'fbPersonnelHTML', 'fbPersonnelNote', 'fbPersonnelEnsure', 'fbGameCardNfl', 'fbP4Request'] });
if (BOOT.error) { console.error('the football module would not run: ' + (BOOT.error.message || BOOT.error)); process.exit(1); }
const win = BOOT.win, T = win.__FBTEST, APP = BOOT.app;
(function () {
  const at = APP.indexOf('function _escHtml(');
  if (at < 0) { console.error('app.html no longer defines _escHtml'); process.exit(1); }
  vm.runInContext(APP.slice(at, APP.indexOf('\n', at)), win);
})();
win.whenLabel = win.whenLabel || (iso => String(iso));
const E = M.loadEngine(win, ROOT);

/* ------------------------------------------------------------- fixtures */
const OFFICIAL = { name: 'ACC availability report', type: 'OFFICIAL', tier: 1, freshness: 'CURRENT' };
function q(v) { return { value: v, basis: 'MEASURED_PRODUCTION', confidence: 0.8, scale: 'EPIR' }; }
function u(v) { return { value: v, basis: 'SNAP_SHARE' }; }
function side(name, absences, o) {
  o = o || {};
  return { team_id: name.toLowerCase(), team_name: name,
    coverage: o.coverage || { grade: 'OFFICIAL', graded: true, official: true, comprehensive: true },
    absences: absences, depth: {}, opponent: { team_name: o.opp || 'Opp', metrics: o.metrics || {} } };
}
function artifact(games) {
  return { schema: 'edgedesk_personnel_impact_v1', config_version: CORE.version,
    projection: { adjustment_points: 0, status: 'NOT_ENABLED', statement: 'Measurement only — coefficient not trained' },
    games: games };
}
const lt = { player_id: 'l1', player_name: 'Big <b>Tackle</b>', position: 'LT', slot: 'LT', slot_depth: 1, status: 'OUT',
  source: OFFICIAL, quality: q(82), usage: u(0.97),
  replacement: { player_id: 'l2', player_name: 'Young Backup', quality: q(46), usage: u(0.1), basis: 'DEPTH_CHART' } };
const cb = { player_id: 'c1', player_name: 'Lockdown Corner', position: 'CB', status: 'QUESTIONABLE', source: OFFICIAL,
  quality: q(70), usage: u(0.9), replacement: { player_id: 'c2', player_name: 'Nickel Kid', quality: q(55), usage: u(0.3), basis: 'DEPTH_CHART' } };
const g1 = CORE.assessGame({ game_id: 'PA1', sport: 'cfb', kickoff: '2026-09-19T23:30:00.000Z',
  home: side('Duke', [lt, cb], { opp: 'Wake Forest', metrics: { def_sack_rate: { z: 1.5, label: 'pass rush (sack rate generated)' } } }),
  away: side('Wake Forest', [], { coverage: { grade: 'LIMITED', graded: false } }) });

/* ------------------------------------------------------------------------ */
section('1. the FBS card carries the compact section');
const st = E.newState();
win.FB.p4.state = st;
const staged = M.stageGame(win, { home: 'Duke', away: 'Wake Forest', game_id: 'PA1', market_spread: -3.5 });
win.FB.personnel.data = null;
const spreadBefore = E.projectGame(T.fbP4Request(staged)).model.fair_spread;
const cardWithout = T.fbP4Card(staged);
win.FB.personnel.data = artifact({ PA1: g1 });
const cardWith = T.fbP4Card(staged);
const spreadAfter = E.projectGame(T.fbP4Request(staged)).model.fair_spread;
has(cardWith, 'Personnel availability', 'the section is on the card');
has(cardWith, 'Impact: ' + g1.home.classification + ' — ' + g1.home.impact + '/100', 'the team impact with its class');
has(cardWith, 'confidence ' + g1.home.confidence + '%', 'the team confidence');
has(cardWith, 'Key losses', 'key losses are listed');
has(cardWith, 'LT1 — ' + g1.home.absences.filter(a => a.slot === 'OT')[0].classification, 'the LT is named by slot with its class');
has(cardWith, 'Projection effect', 'the projection effect line');
has(cardWith, 'Not enabled · 0.0 points', 'which says it is not enabled and moves 0.0 points');
has(cardWith, 'not assessable', 'a side with no graded read is not assessable, never healthy');
has(cardWith, 'Cannot compare', 'the comparison refuses to compare an unassessable side');
has(cardWith, '<details class="gxl"><summary>Full evidence', 'full evidence is behind a collapsed <details>');
lacks(cardWith, '<details class="gxl" open', 'and it is collapsed by default');
has(cardWith, 'drop from his 82 rating', 'the evidence explains the replacement gap');
has(cardWith, 'Big &lt;b&gt;Tackle&lt;/b&gt;', 'player names are escaped');
lacks(cardWith, 'Big <b>Tackle</b>', 'and never injected as markup');
has(cardWith, 'projection effect not enabled', 'the section header carries the one-line summary');

section('2. the section changes nothing else on the card');
ok(spreadBefore === spreadAfter, 'the model fair spread is identical with and without the personnel artifact', [spreadBefore, spreadAfter]);
(function () {
  const start = cardWith.indexOf('<div class="gx-sec open" id="gxs-PA1_personnel">');
  /* the next section's own opening tag (gx-sec is also a prefix of gx-sec-b) */
  const nextId = cardWith.indexOf(' id="gxs-PA1_', cardWith.indexOf('>', start) + 1);
  const end = cardWith.lastIndexOf('<div class="gx-sec', nextId);
  ok(start >= 0 && end > start, 'the personnel section is one gx-sec block', [start, end]);
  const cut = cardWith.slice(0, start) + cardWith.slice(end);
  let i = 0; while (i < cut.length && cut[i] === cardWithout[i]) i++;
  ok(cut === cardWithout, 'cutting the section out leaves exactly the card rendered without the artifact',
    { at: i, with: cut.slice(Math.max(0, i - 120), i + 200), without: cardWithout.slice(Math.max(0, i - 120), i + 200) });
})();
ok(T.fbPersonnelHTML('PA1') !== '' && T.fbPersonnelHTML('NOPE') === '', 'a game with no assessment renders nothing');
win.FB.personnel.data = null;
lacks(T.fbP4Card(staged), 'Personnel availability', 'a missing artifact leaves no trace');

section('3. the NFL card');
M.loadNflEngine(win, ROOT);
const nflG = CORE.assessGame({ game_id: 'NFLPA1', sport: 'nfl', kickoff: '2026-09-10T00:35:00.000Z',
  home: side('Buffalo Bills', [{ player_id: '00-1', player_name: 'Right Tackle', position: 'T', status: 'Out', source: OFFICIAL,
    quality: { value: null, basis: 'NO_PLAYER_RATING_FEED' } }]),
  away: side('Detroit Lions', []) });
const nu = M.stageNflGame(win, { game_id: 'NFLPA1', home: 'BUF', away: 'DET', names: { BUF: 'Buffalo Bills', DET: 'Detroit Lions' } });
win.FB.personnel.data = artifact({ NFLPA1: nflG });
let nflCard = '';
try { nflCard = T.fbGameCardNfl(nu); } catch (e) { ok(false, 'the NFL card renders', String(e && e.stack || e)); }
has(nflCard, 'Personnel availability', 'the NFL card carries the section');
has(nflCard, 'not rated — 1 absence on file, none with measured player quality', 'an NFL absence is listed unrated, never zero');
has(nflCard, 'Not enabled · 0.0 points', 'and the projection effect line');
win.FB.personnel.data = null;
let nflBare = '';
try { nflBare = T.fbGameCardNfl(nu); } catch (_) { nflBare = ''; }
lacks(nflBare, 'Personnel availability', 'no artifact, no NFL section');

section('4. the committed artifact renders');
(function () {
  const cur = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'personnel', 'current.json'), 'utf8'));
  win.FB.personnel.data = cur;
  let bad = [];
  Object.keys(cur.games).forEach(function (id) {
    try { const h = T.fbPersonnelHTML(id); if (!/Projection effect/.test(h)) bad.push(id); } catch (e) { bad.push(id + ': ' + e.message); }
  });
  ok(bad.length === 0, 'every committed game renders the section with its projection-effect line', bad.slice(0, 5));
  win.FB.personnel.data = null;
})();

section('5. wiring');
has(APP, "fetch('football/personnel/current.json'", 'the page reads the committed artifact');
has(APP, 'try{ fbPersonnelEnsure(); }catch(_){}', 'the FBS board loads it beside the starter context');
has(APP, "if(typeof fbPersonnelEnsure==='function')fbPersonnelEnsure();", 'the NFL board loads it too');
has(APP, "+fbGxSec(gid,'personnel','Personnel availability',fbPersonnelHTML(gid),true,fbPersonnelNote(gid))", 'the FBS card section');
lacks(APP.slice(APP.indexOf('function fbP4Request('), APP.indexOf('function fbP4Request(') + 6000), 'fbPersonnel',
  'the request the engine prices is not built from the personnel layer');

console.log('\n' + (failures ? 'FAILED — ' : 'PASS — ') + checks + ' checks' + (failures ? ', ' + failures + ' failed' : ''));
process.exit(failures ? 1 : 0);
