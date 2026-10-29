#!/usr/bin/env node
/* ============================================================================
   SP+ ON THE CFB BOARD CARD, THROUGH THE REAL FOOTBALL MODULE.

   The real module out of app.html (tools/football/_module.js), the committed
   CFB engine and the real lib files, loaded as the page loads them. A game is
   staged with its raw margin steered to a target; SP+'s weekly file is staged
   beside it; the card summary is rendered by the page's own fbGxSummary.

   Run: node football/sp_plus/card_ui.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('../../tools/football/_module.js');
const ROOT = M.ROOT;

let checks = 0, failures = 0;
function ok(cond, what, detail) {
  checks++;
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { detail = String(e && e.stack || e).slice(0, 400); cond = false; } }
  if (cond) return;
  failures++; console.error('  FAIL: ' + what + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 400)));
}
function has(hay, needle, what) { ok(String(hay).indexOf(needle) >= 0, what, { missing: needle }); }
function lacks(hay, needle, what) { ok(String(hay).indexOf(needle) < 0, what, { present: needle }); }

const BOOT = M.boot({ probe: ['fbP4ViewFor', 'fbGxSummary', 'fbP4Request', 'fbP4Market'] });
if (BOOT.error) { console.error('the football module would not run: ' + (BOOT.error.message || BOOT.error)); process.exit(1); }
const win = BOOT.win, T = win.__FBTEST;
['function _escHtml(', 'function edEsc(', 'function edAttrJs(', 'function ago('].forEach((sig) => {
  const at = BOOT.app.indexOf(sig);
  if (at < 0) { console.error('app.html no longer defines ' + sig); process.exit(1); }
  vm.runInContext(BOOT.app.slice(at, BOOT.app.indexOf('\n', at)), win);
});
win.whenLabel = win.whenLabel || ((iso) => String(iso));
win.edEvent = win.edEvent || (() => {});
const E = M.loadEngine(win, ROOT);
['edgedesk_calc.js', 'cfb_research_view.js', 'edgedesk_canon.js'].forEach((f) => {
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib', f), 'utf8'), win, { filename: 'lib/' + f });
});

/* the page loads SP+ the way it loads the research view, and reads the file in the football boot */
const LIB = 'lib/cfb_sp_plus.js';
has(BOOT.app, '<script src="/' + LIB + '?v=', 'app.html loads ' + LIB + ' with a plain <script> tag');
has(BOOT.app, 'window.EDCfbSpPlus.fetchLines(window.EDCfbSpPlus.URL)', 'and reads football/sp_plus/lines.json during the football boot');
vm.runInContext(fs.readFileSync(path.join(ROOT, LIB), 'utf8'), win, { filename: LIB });
ok(!!win.EDCfbSpPlus, 'EDCfbSpPlus is on window, as the card reads it');

const HOME = 'Middle Tennessee', AWAY = 'Kennesaw State';
const HK = E.normKey(HOME), AK = E.normKey(AWAY);
function markComplete(st) {
  st.canonicalRatingMeta = { schema: 'staged', staged: true };
  win.FB.p4.engineEfficiency = { schema: 'edgedesk_cfb_engine_efficiency_v1', staged: true };
  win.FB.p4.efficiencyReplay = { games: 0, team_rows: 0, missing: 0, error: null, late_joined: 0 };
  win.FB.p4.schedFallback = [];
  return st;
}
function stageAt(target, gid) {
  const st = markComplete(E.newState());
  st.canonicalRatings = {}; st.canonicalRatings[HK] = { value: 0 }; st.canonicalRatings[AK] = { value: 0 };
  win.FB.p4.state = st;
  const stage = { home: HOME, away: AWAY, neutral_site: false, home_conference: 'Conference USA', away_conference: 'Conference USA', game_id: gid };
  let u = M.stageGame(win, stage);
  const rest = E.projectGame(T.fbP4Request(u)).model.fair_spread;
  st.canonicalRatings[HK].value = target - rest;
  u = M.stageGame(win, stage);
  const p = E.projectGame(T.fbP4Request(u));
  win.FB.p4._proj = {}; win.FB.p4._proj[String(u.g.game_id)] = p;
  win.FB.p4._mkt = {}; win.FB.p4._mkt[String(u.g.game_id)] = T.fbP4Market(u);
  return { u, p };
}
const NOWISO = new Date(Date.now() - 2 * 864e5).toISOString();
function lines(over) {
  return Object.assign({ schema: 'edgedesk_cfb_sp_plus_lines_v1', status: 'OK',
    last_attempt: { at: NOWISO, week_key: '2026:0:09', status: 'OK', reason: null },
    snapshot: { season: 2026, week: 9, week_key: '2026:0:09', captured_at: NOWISO, source_version: 'cfbd-ratings-sp:2026:abcdef012345' },
    games: { SP1: { home: HOME, away: AWAY, week: 9, week_key: '2026:0:09', state: 'AVAILABLE', reason: null, home_margin: 1.3, home_line: -1.3 } } }, over || {});
}

console.log('\nSP+ on the board card');
{
  win.EDCfbSpPlus.load(lines());
  const s = stageAt(4.52, 'SP1');
  ok(Math.abs(s.p.model.fair_spread - 4.52) < 1e-6, 'EdgeDesk’s raw margin was steered to 4.52 (MTSU −4.5)', s.p.model.fair_spread);
  const card = T.fbGxSummary(s.u, s.p, 'SP1');
  has(card, 'SP+ projection', 'the card has an SP+ projection cell');
  has(card, HOME + ' −1.3', 'with the SP+ line, named for its favourite');
  has(card, 'T3 external model · T2 computed line', 'labelled external (T3) and computed (T2)');
  has(card, 'SP+ week 9', 'with its source week');
  has(card, 'Projection derived from SP+ (ESPN, Bill Connelly). Data provided by CollegeFootballData.com.', 'with the attribution, word for word');
  has(card, 'Models disagree', 'EdgeDesk 4.5 vs SP+ 1.3: the plain note');
  has(card, '3.2 points apart', 'with the size of the gap');
  has(card, 'EdgeDesk fair', 'EdgeDesk’s own fair line is still on the card');
  ok(card.indexOf('EdgeDesk fair') < card.indexOf('SP+ projection') && card.indexOf('SP+ projection') < card.indexOf('Projected score'),
    'and SP+ sits beside it, after the market cells and before the projected score');
  const close = stageAt(2.0, 'SP1');
  const c2 = T.fbGxSummary(close.u, close.p, 'SP1');
  has(c2, HOME + ' −1.3', 'a smaller gap still shows the SP+ line');
  lacks(c2, 'Models disagree', 'but no disagreement note under 3 points');
  ok(Math.abs(close.p.model.fair_spread - 2.0) < 1e-6, 'EdgeDesk’s own number is untouched by SP+ (still the staged 2.0)', close.p.model.fair_spread);
}
{
  win.EDCfbSpPlus.load(lines({ snapshot: Object.assign(lines().snapshot, { captured_at: new Date(Date.now() - 10 * 864e5).toISOString() }) }));
  const s = stageAt(4.52, 'SP1');
  const card = T.fbGxSummary(s.u, s.p, 'SP1');
  has(card, 'SP+ projection', 'a stale capture still shows the row');
  has(card, 'unavailable', 'as unavailable');
  has(card, 'older than the current week', 'with the reason');
  lacks(card, HOME + ' −1.3', 'and never the stale number');
  lacks(card, 'Models disagree', 'and no comparison');
}
{
  win.EDCfbSpPlus.load(lines({ snapshot: null, status: 'FAILED', last_attempt: { at: NOWISO, week_key: '2026:0:09', status: 'FAILED', reason: 'CollegeFootballData answered HTTP 500' } }));
  const s = stageAt(4.52, 'SP1');
  const card = T.fbGxSummary(s.u, s.p, 'SP1');
  has(card, 'the SP+ sync failed: CollegeFootballData answered HTTP 500', 'a failed sync: unavailable, with the failure');
  win.EDCfbSpPlus.load(null);
  has(T.fbGxSummary(s.u, s.p, 'SP1'), 'the SP+ file did not load', 'no file: unavailable, and says the file did not load');
}

console.log('\n' + (failures ? 'FAILED ' : 'ALL GREEN ') + (checks - failures) + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
