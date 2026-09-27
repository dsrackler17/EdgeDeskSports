#!/usr/bin/env node
/* ===========================================================================
   Tests for the game-level debug view (admin/cfb-debug/index.html) and the
   prediction trace behind it (trace.js, via projections.js), as WIRED.

   The EDDEBUG block is cut out of the page between its markers and run in a
   sandbox against files written by the real builder (projections.build at a
   fixed time over this repository), against nothing (the files failed to
   load), and against hostile files (markup in every string the page prints).

   Run: node football/cfb_production/debug_ui.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const PR = require('./projections.js');
const TR = require('./trace.js');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.message) || e) }; } }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}

const PAGE = fs.readFileSync(path.join(ROOT, 'admin', 'cfb-debug', 'index.html'), 'utf8');
const a = PAGE.indexOf('/*__EDDEBUG_START__*/'), b = PAGE.indexOf('/*__EDDEBUG_END__*/');
const block = PAGE.slice(a, b + '/*__EDDEBUG_END__*/'.length);

/* ---- structure ------------------------------------------------------------ */
chk('the page is noindex, nofollow', /<meta name="robots" content="noindex, nofollow">/.test(PAGE));
chk('no external script, stylesheet or font', !/<script[^>]*\ssrc\s*=/i.test(PAGE) && !/<link[^>]+rel=["']?stylesheet/i.test(PAGE) && !/@import|fonts\.googleapis/i.test(PAGE));
chk('colour tokens: dark by default, light by preference and by data-theme', /\.viz-root\{\s*color-scheme:dark/.test(PAGE) && /@media \(prefers-color-scheme: light\)/.test(PAGE) && /:root\[data-theme="light"\] \.viz-root/.test(PAGE));
chk('16px side gutter, no horizontal page scroll', /\.wrap\{[^}]*padding:0 16px/.test(PAGE) && /body\.viz-root\{[^}]*overflow-x:hidden/.test(PAGE));
chk('the header comment names both files and says it computes nothing', /computes nothing of its own/.test(PAGE) && /reports\/projections\.json/.test(PAGE) && /reports\/traces\.json/.test(PAGE));
chk('the pure block has no DOM, network or storage access', a > 0 && b > a && !/document\.|location\.|fetch\(|localStorage|sessionStorage|innerHTML/.test(block));
chk('the page loads no engine and makes no number (no pure/decide/card, no engine or params file)', !/EDCfbV2|cfb_v2\/(engine|params)\.js|\.pure\(|\.decide\(/.test(PAGE));
chk('the boot reads both files and only a safe game id from the URL', /projections\.json/.test(PAGE.slice(b)) && /traces\.json/.test(PAGE.slice(b)) && /\[\?&\]game=\(\[A-Za-z0-9_-\]\{1,40\}\)/.test(PAGE.slice(b)));
chk('the page writes nothing (no POST/PATCH/DELETE, no RPC)', !/method\s*:\s*['"](POST|PATCH|PUT|DELETE)['"]|\/rpc\//.test(PAGE));

const ctx = { window: {}, console, encodeURIComponent };
ctx.window.window = ctx.window;
vm.createContext(ctx);
vm.runInContext(block, ctx);
const E = ctx.window.EDDEBUG;
chk('EDDEBUG exposes render, listView, gameView, stageBody', E && ['render', 'listView', 'gameView', 'stageBody'].every((k) => typeof E[k] === 'function'));

/* ---- the real files -------------------------------------------------------- */
const NOW = '2026-09-28T12:00:00.000Z';
const P = PR.build({ now: NOW });
const T = JSON.parse(JSON.stringify(P.traces));
const Pj = JSON.parse(JSON.stringify(P));
chk('projections.json does not carry the traces (the public page never downloads them)', !('traces' in Pj) && !JSON.stringify(Pj).includes('"stages"'));
chk('traces.json has one trace per game, every stage in order', Pj.games.length > 10 && Pj.games.every((g) => Array.isArray(T.games[g.game_id]) && T.games[g.game_id].map((s) => s.stage).join() === TR.STAGES.join()),
  Pj.games.filter((g) => !T.games[g.game_id]).map((g) => g.game_id));
const pred = Pj.games.find((g) => g.canonical && g.canonical.status === 'PREDICTED');
const st = (g, k) => T.games[g.game_id].find((s) => s.stage === k);
chk('trace: the submodel shares sum to the stacked margin (the ensemble stage shows the difference)', Pj.games.filter((g) => g.canonical && g.canonical.status === 'PREDICTED').every((g) => Math.abs(st(g, 'ensemble').difference) < 0.006));
chk('trace: the calibration stage carries the engine\'s and the weekly engine\'s probability and their difference', Pj.games.filter((g) => g.canonical && g.canonical.status === 'PREDICTED').every((g) => {
  const c = st(g, 'calibration'); return typeof c.home_win_prob === 'number' && typeof c.weekly_engine_p_home === 'number' && Math.abs(c.engine_vs_weekly) <= 1e-4; }));
chk('trace: the numbers are the canonical snapshot\'s (the trace copies, it does not recompute)', Pj.games.filter((g) => g.canonical && g.canonical.status === 'PREDICTED').every((g) =>
  st(g, 'ensemble').projected_margin === g.canonical.projection.projected_margin && st(g, 'calibration').sigma === g.canonical.projection.sigma
  && st(g, 'outcome').fallback_level === g.canonical.fallback_level && JSON.stringify(st(g, 'outcome').degraded_modes) === JSON.stringify(g.canonical.degraded.modes)));
chk('trace: the decision stage keeps the official decision and the research class apart', Pj.games.every((g) => {
  const d = st(g, 'decision'); return JSON.stringify(d.official) === JSON.stringify(g.official_decision) && JSON.stringify(d.research) === JSON.stringify(g.research); }));
chk('trace: a NOT_PRICED game (FBS vs FCS) still has its trace and says so', Pj.games.filter((g) => g.canonical && g.canonical.status === 'NOT_PRICED').every((g) => st(g, 'outcome').status === 'NOT_PRICED'));

const clean = (h) => !/undefined|NaN|>null</.test(h);
const list = E.render(Pj, T, null);
chk('list: every game is listed with a link to its view', Pj.games.every((g) => list.includes('?game=' + g.game_id)) && clean(list), list.slice(0, 200));
chk('list: the official decision and the research class are separate columns, research labelled', /official decision/.test(list) && /research class/.test(list) && /Research class: the stage-8 rule, research only/.test(list));
const view = E.render(Pj, T, pred.game_id);
chk('game view: every stage has its card, in order', TR.STAGES.every((k, i, arr) => view.indexOf('id="st-' + k + '"') > 0 && (i === 0 || view.indexOf('id="st-' + arr[i - 1] + '"') < view.indexOf('id="st-' + k + '"'))));
chk('game view: the numbers shown are the stored ones', view.includes(String(pred.canonical.projection.fair_spread_display).replace(/&/g, '&amp;')) && view.includes(pred.canonical.snapshot_id) && clean(view));
chk('game view: "Official decision (governed policy)" and "Research only (stage-8 class, not a decision)" are separate', /Official decision \(governed policy\)/.test(view) && /Research only \(stage-8 class, not a decision\)/.test(view));
chk('game view: the stage-8 research status is never drawn as the official chip', (() => {
  const off = view.slice(view.indexOf('Official decision (governed policy)'), view.indexOf('Research only (stage-8'));
  return /<span class="chip[^"]*">NO_DECISION<\/span>|<span class="chip[^"]*">UNAVAILABLE<\/span>/.test(off) && !(pred.research && pred.research.status === 'LEAN' && /<span class="chip[^"]*">LEAN<\/span>/.test(off));
})());
chk('game view: an unknown game says so and links back', /is not in projections\.json/.test(E.render(Pj, T, '999999999')) && /href="\?"/.test(E.render(Pj, T, '999999999')));
chk('game view: without traces.json the game still renders and says the trace is missing', /No prediction trace/.test(E.render(Pj, null, pred.game_id)) && /traces\.json not loaded/.test(E.render(Pj, null, pred.game_id)));
chk('files from different runs are called out', /are from different runs/.test(E.render(Pj, Object.assign({}, T, { as_of_ts: '2026-09-28T11:00:00.000Z' }), null)));
/* a closing-line tendency is labelled as such (F-23) */
const withTendency = JSON.parse(JSON.stringify(T));
const dstage = withTendency.games[pred.game_id].find((s) => s.stage === 'decision');
dstage.official = { status: 'PASS', basis: 'cfb_decision_policy_v1', closing_line_tendency: { label: 'strong', p_positive_clv: 0.6, note: PR.TENDENCY_NOTE } };
const tv = E.render(Pj, withTendency, pred.game_id);
chk('F-23: the P(positive CLV) tier is shown as a closing-line tendency, never as edge or bet quality', /Closing-line tendency/.test(tv) && /not bet quality/.test(tv) && !/(Edge|Bet) quality/.test(tv));

/* ---- nothing, and hostile files ------------------------------------------ */
chk('nothing loaded: says projections.json could not be read, never throws', /could not be read/.test(E.render(null, null, null)) && /could not be read/.test(E.render({}, null, '1')));
const X = '<img src=x onerror=alert(1)>';
const hostile = JSON.parse(JSON.stringify(Pj));
hostile.model_version = X; hostile.champion = X;
hostile.games.forEach((g) => { g.home = X; g.away = X + '"\''; g.game_id = String(g.game_id); if (g.canonical) { g.canonical.snapshot_id = X; if (g.canonical.projection) g.canonical.projection.fair_spread_display = X; } g.official_decision = { status: X, reason: X }; g.research = { status: X }; });
const ht = JSON.parse(JSON.stringify(T));
Object.keys(ht.games).forEach((k) => ht.games[k].forEach((s) => { Object.keys(s).forEach((f) => { if (f !== 'stage') s[f] = typeof s[f] === 'object' && s[f] ? { [X]: X } : X; }); }));
ht.stages = TR.STAGES.concat([X]);
const hv = E.render(hostile, ht, hostile.games[0].game_id) + E.render(hostile, ht, null) + E.render(hostile, ht, X);
chk('hostile files: no markup from the files reaches the page unescaped', !/<img|onerror=alert\(1\)>/.test(hv.replace(/&lt;img src=x onerror=alert\(1\)&gt;/g, '')) && !/<img/.test(hv), hv.match(/.{0,40}<img.{0,40}/));
chk('hostile files: every stage still renders', TR.STAGES.every((k) => hv.includes('id="st-' + k + '"')));

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')));
console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
