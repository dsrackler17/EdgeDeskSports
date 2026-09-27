#!/usr/bin/env node
/* The CFB V2 shadow panel, cut out of app.html and run against the STORED
   canonical projections built from the real current.json by
   football/cfb_production/projections.js. `node tools/football/cfb_v2_panel.test.js`

   What it proves: the panel renders for a priced game from stored numbers only
   (no engine is loaded here or on the page), says NOT_PRICED for an
   FBS-vs-FCS row, shows the governed policy's status as the official one and
   the stage-8 status only as research, never emits BET while BET is disabled,
   shows the stored market home line exactly once, and is invisible unless
   the reader opts in. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const app = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

let fail = 0, n = 0;
function ok(c, what) { n++; if (!c) { fail++; console.log('FAIL ' + what); } else console.log('ok   ' + what); }

function cut(name) {                     // a top-level function from app.html, brace-matched
  const at = app.indexOf('function ' + name + '(');
  if (at < 0) throw new Error('missing ' + name);
  let i = app.indexOf('{', at), depth = 0;
  for (; i < app.length; i++) {
    if (app[i] === '{') depth++;
    else if (app[i] === '}') { depth--; if (depth === 0) break; }
  }
  return app.slice(at, i + 1);
}

const ctx = { window: {}, location: { search: '' }, localStorage: { getItem: () => null },
  console, JSON, Math, Object, Array, String, Date, Promise };
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext('var FBV2={games:null,loading:null,err:null};', ctx);
const words = /var FB_V2_MODE_WORDS=\{[^;]*\};/.exec(app);
if (words) vm.runInContext(words[0], ctx);
['_escHtml', 'fbEsc', 'fbPts', 'fbV2On', 'fbV2ShadowHTML'].forEach(function (f) {
  try { vm.runInContext(cut(f), ctx); } catch (e) {
    if (f === 'fbEsc') vm.runInContext("function fbEsc(s){return String(s==null?'':s).replace(/[&<>\"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c];});}", ctx);
    else throw e;
  }
});

/* the stored report, exactly as the hourly job builds it, at an instant before the slate */
const PR = require(path.join(ROOT, 'football', 'cfb_production', 'projections.js'));
const cur = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_v2', 'current.json'), 'utf8'));
const first = cur.rows.map(function (r) { return Date.parse(r.kickoff); }).sort()[0];
const rep = PR.build({ now: new Date(first - 6 * 3600000).toISOString(), predictions: [], decisions: [] });
ctx.FBV2.games = {};
rep.games.forEach(function (g) { ctx.FBV2.games[String(g.game_id)] = g; });
const priced = rep.games.find(function (g) { return g.canonical && g.canonical.status === 'PREDICTED'; });
const fcs = rep.games.find(function (g) { return g.canonical && g.canonical.status === 'NOT_PRICED'; });

ok(ctx.fbV2On() === false, 'panel is off unless the reader opts in');
ctx.location.search = '?cfbv2=1';
ok(ctx.fbV2On() === true, '?cfbv2=1 turns it on');
ok(!/EDCfbV2|cfb_v2\/engine\.js|cfb_v2\/params\.js/.test(cut('fbV2ShadowHTML') + cut('fbV2Ensure')), 'the page loads no engine for V2: it reads the stored projection');

/* the Model Lab captured a market for this game: home -3.5 */
priced.market = { home_line: -3.5, gap: 1, books: 2, actionable_status: 'ACTIONABLE', stale: false };
priced.research = { status: 'LEAN', basis: PR.RESEARCH_BASIS };
const u = { g: { game_id: priced.game_id, home_team: priced.home, away_team: priced.away } };
const html = ctx.fbV2ShadowHTML(u, null);
ok(/EdgeDesk pure projection/.test(html) && /Market \(separate layer\)/.test(html), 'pure and market blocks are both there, separately');
ok(/SHADOW/.test(html), 'labelled SHADOW');
ok(html.indexOf(priced.home + ' -3.5') >= 0 && html.indexOf(priced.home + ' +3.5') < 0, 'the stored home line -3.5 is shown as the home line, converted nowhere');
ok(html.indexOf('Fair spread</span><span class="v mdl">' + priced.canonical.projection.fair_spread_display) >= 0, 'the fair spread is the stored one');
ok(!/<b>BET<\/b>/.test(html), 'no BET while BET is disabled');
ok(/Official decision<\/span><span class="v"><b>NO DECISION<\/b>/.test(html) && !/Official decision<\/span><span class="v"><b>LEAN/.test(html), 'the official status is the governed policy\'s, not the stage-8 LEAN');
ok(/Research only<\/span><span class="v mut">LEAN — the stage-8 rule/.test(html), 'the stage-8 status is shown only as research');
ok(!/lock|guarantee|can.t miss/i.test(html), 'no certainty language');
if (fcs) {
  const h2 = ctx.fbV2ShadowHTML({ g: { game_id: fcs.game_id, home_team: fcs.home, away_team: fcs.away } }, null);
  ok(/NOT_PRICED/.test(h2) && !/Fair spread/.test(h2), 'FBS-vs-FCS row renders NOT_PRICED, no number');
}
ok(/No stored V2 projection/.test(ctx.fbV2ShadowHTML({ g: { game_id: 1 } }, null)), 'a game with no stored projection says so');
console.log((n - fail) + '/' + n + ' passed');
process.exit(fail ? 1 : 0);
