#!/usr/bin/env node
/* The CFB V2 shadow panel, cut out of app.html and run against the real V2
   engine, params and current.json. `node tools/football/cfb_v2_panel.test.js`

   What it proves: the panel renders for a priced game, says NOT_PRICED for an
   FBS-vs-FCS row, never emits BET while BET is disabled, converts V1's margin-
   convention market number to a book line exactly once, and is invisible
   unless the reader opts in. */
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
vm.runInContext(fs.readFileSync(path.join(ROOT, 'football', 'cfb_v2', 'params.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'football', 'cfb_v2', 'engine.js'), 'utf8'), ctx);
vm.runInContext('var FBV2={rows:null,loading:null,err:null};', ctx);
['_escHtml', 'fbEsc', 'fbPts', 'fbV2On', 'fbV2ShadowHTML'].forEach(function (f) {
  try { vm.runInContext(cut(f), ctx); } catch (e) {
    if (f === 'fbEsc') vm.runInContext("function fbEsc(s){return String(s==null?'':s).replace(/[&<>\"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c];});}", ctx);
    else throw e;
  }
});

const cur = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'cfb_v2', 'current.json'), 'utf8'));
ctx.FBV2.rows = {};
cur.rows.forEach(function (r) { ctx.FBV2.rows[String(r.game_id)] = r; });
const priced = cur.rows.find(function (r) { return r.priced !== false; });
const fcs = cur.rows.find(function (r) { return r.priced === false; });

ok(ctx.fbV2On() === false, 'panel is off unless the reader opts in');
ctx.location.search = '?cfbv2=1';
ok(ctx.fbV2On() === true, '?cfbv2=1 turns it on');

const u = { g: { game_id: priced.game_id, home_team: priced.home, away_team: priced.away } };
const V1margin = 3.5;                     // V1's market.spread_line is a HOME MARGIN
const html = ctx.fbV2ShadowHTML(u, { market: { spread_line: V1margin, as_of: new Date().toISOString() } });
ok(/EdgeDesk pure projection/.test(html) && /Market \(separate layer\)/.test(html), 'pure and market blocks are both there, separately');
ok(/SHADOW/.test(html), 'labelled SHADOW');
ok(html.indexOf(priced.home + ' -3.5') >= 0, 'V1 margin +3.5 is shown as book line -3.5 (one conversion)');
ok(!/<b>BET<\/b>/.test(html), 'no BET while BET is disabled');
ok(!/lock|guarantee|can.t miss/i.test(html), 'no certainty language');
ok(/EV not computable|no price/i.test(html), 'no captured price -> EV is not computable, never assumed -110');
if (fcs) {
  const h2 = ctx.fbV2ShadowHTML({ g: { game_id: fcs.game_id, home_team: fcs.home, away_team: fcs.away } }, {});
  ok(/NOT_PRICED/.test(h2), 'FBS-vs-FCS row renders NOT_PRICED, no number');
}
ok(/No frozen V2 snapshot/.test(ctx.fbV2ShadowHTML({ g: { game_id: 1 } }, {})), 'a game with no snapshot says so');
console.log((n - fail) + '/' + n + ' passed');
process.exit(fail ? 1 : 0);
