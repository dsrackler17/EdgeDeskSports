#!/usr/bin/env node
/* ===========================================================================
   The Signal Center capability registry (lib/edgedesk_signal_registry.js),
   held to the repository: a sport supports a signal because a dated source
   exists, not because it is in a menu.

     node tools/signal_center/registry.test.js

     sources      every capability a sport may publish from names a source,
                  and a file source exists in the repository (a database
                  source names the tables the worker actually reads)
     simulator    the Simulator's own registry decides, never overridden: a
                  sport is EXPERIMENTAL for simulator shifts only while the
                  Simulator says ACTIVE
     categories   every category is one the engine knows; the unsupported
                  three are refused everywhere with their reason
     rollout      live candidates are NFL and college football; nothing else
                  rolls out live first
     honesty      NFL injuries stay BLOCKED (no per-row publication time); MLB
                  has no forecast history; NBA/NHL divergences are experimental
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const R = require(path.join(ROOT, 'lib', 'edgedesk_signal_registry.js'));
const SIM = require(path.join(ROOT, 'lib', 'edgedesk_simulator_sports.js'));
const E = require(path.join(ROOT, 'lib', 'edgedesk_signal_engine.js'));
const DBJS = fs.readFileSync(path.join(__dirname, 'db.js'), 'utf8');

let pass = 0, fail = 0;
function chk(name, cond, detail) {
  if (cond) { pass++; return; }
  fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : ''));
}
const STATES = Object.keys(R.STATES);
const sports = R.sports();
const OK = (s) => s === 'OPERATIONAL' || s === 'EXPERIMENTAL';

chk('the registry lists sports', sports.length >= 7, sports.length);
chk('every state is a known state', sports.every((s) => Object.values(s.capabilities).concat(Object.values(s.signals)).every((c) => STATES.indexOf(c.state) >= 0)));

/* ---- sources ---- */
function fileExists(src) {
  /* a pattern names a family of files: at least one member must exist */
  const clean = String(src).split(/\s+\+\s+|\s*,\s*|\s+\(/)[0].trim();
  if (/^public\./.test(clean)) return null;           // a database source, checked below
  if (/[<*]/.test(clean)) {
    const dir = path.join(ROOT, path.dirname(clean.replace(/<[^>]+>.*$/, 'x')));
    return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  }
  return fs.existsSync(path.join(ROOT, clean));
}
sports.forEach((s) => {
  Object.keys(s.signals).forEach((cat) => {
    const c = s.signals[cat];
    if (!OK(c.state)) { chk(s.key + ' ' + cat + ': a refused state says why', !!(c.detail && c.detail.length > 10), c); return; }
    chk(s.key + ' ' + cat + ': a publishable signal names its source', !!c.source, c);
    const ex = fileExists(c.source);
    if (ex === null) {
      const tables = String(c.source).match(/public\.([a-z_]+)/g) || [];
      chk(s.key + ' ' + cat + ': its database source is a table the worker reads', tables.length > 0 && tables.some((t) => DBJS.indexOf(t.slice(7)) >= 0), c.source);
    } else chk(s.key + ' ' + cat + ': its source exists in the repository (' + c.source + ')', ex === true);
  });
});
Object.keys(R.SOURCES).forEach((k) => chk('the source list names ' + k, !!R.SOURCES[k]));

/* ---- the Simulator decides ---- */
SIM.sports.forEach((x) => {
  const mine = R.sport(x.key);
  if (!mine) return;
  const st = mine.signals.SIMULATION_SHIFT.state;
  chk(x.key + ': simulator shifts follow the Simulator (' + x.status + ' → ' + st + ')',
    x.status === 'ACTIVE' ? (R.SIM_OUTCOME_SPORTS.indexOf(x.key) >= 0 ? st === 'EXPERIMENTAL' : !OK(st)) : (x.status === 'BLOCKED' ? st === 'BLOCKED' : !OK(st)), { sim: x.status, mine: st });
});
chk('a sport the Simulator does not know has no simulator shift', !OK(R.simulator('golf_doesnotexist').state));
chk('the registry\'s simulator outcome sports are the engine\'s, exactly', JSON.stringify(R.SIM_OUTCOME_SPORTS.slice().sort()) === JSON.stringify(Object.keys(E.SIM_OUTCOMES).sort()), [R.SIM_OUTCOME_SPORTS, Object.keys(E.SIM_OUTCOMES)]);
sports.forEach((s) => {
  if (OK(s.signals.SIMULATION_SHIFT.state)) chk(s.key + ': a publishable simulator shift has outcome definitions in the engine', !!E.SIM_OUTCOMES[s.key]);
});
chk('UFC is the Simulator\'s ufc', R.sport('mma').capabilities.simulator.detail !== 'The Simulator has no module for this sport.' || !SIM.sports.some((x) => x.key === 'ufc'));
chk('the CFB simulator capability says selection is Estimated, never known', /Estimated \(committee proxy\), never known/.test(R.sport('cfb').capabilities.simulator.detail) || R.sport('cfb').capabilities.simulator.state !== 'EXPERIMENTAL');

/* ---- categories ---- */
const KNOWN = Object.keys(E.CATEGORIES);
sports.forEach((s) => Object.keys(s.signals).forEach((cat) => chk(s.key + ': ' + cat + ' is a category the engine knows', KNOWN.indexOf(cat) >= 0)));
Object.keys(R.UNSUPPORTED).forEach((cat) => sports.forEach((s) => {
  const e = R.eligible(s.key, cat);
  if (s.key === 'nfl' || s.key === 'cfb') chk(s.key + ': ' + cat + ' is refused with its reason', !e.ok && e.reason === R.UNSUPPORTED[cat]);
}));
chk('an unknown sport is refused', R.eligible('quidditch', 'FORECAST_SHIFT').ok === false);

/* ---- rollout ---- */
chk('NFL and college football are the live candidates, and only they', JSON.stringify(R.LIVE_CANDIDATES.slice().sort()) === JSON.stringify(['cfb', 'nfl']));
chk('their rollout says so', R.sport('nfl').rollout === 'LIVE_CANDIDATE' && R.sport('cfb').rollout === 'LIVE_CANDIDATE');
chk('no other sport is a live candidate', sports.filter((s) => s.rollout === 'LIVE_CANDIDATE').map((s) => s.key).sort().join() === 'cfb,nfl');

/* ---- honest states ---- */
chk('NFL injuries stay BLOCKED: no per-row publication time', R.sport('nfl').signals.INJURY_IMPACT.state === 'BLOCKED');
chk('NFL and college football forecast shifts are operational', R.eligible('nfl', 'FORECAST_SHIFT').ok && R.eligible('cfb', 'FORECAST_SHIFT').ok);
chk('MLB has no forecast history to compare', R.eligible('mlb', 'FORECAST_SHIFT').ok === false);
chk('NBA and NHL divergences are experimental, not operational', R.sport('nba').signals.MARKET_DIVERGENCE.state === 'EXPERIMENTAL' && R.sport('nhl').signals.MARKET_DIVERGENCE.state === 'EXPERIMENTAL');
chk('tennis and golf publish nothing (no model; their Simulator results have no outcome definition here)', ['tennis', 'golf'].every((k) => !R.sport(k) || Object.values(R.sport(k).signals).every((c) => !OK(c.state))));

console.log((fail ? 'FAILED' : 'ALL GREEN') + ' signal center registry — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
