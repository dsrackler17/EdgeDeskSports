#!/usr/bin/env node
/* ============================================================================
   THE CFB RESEARCH VIEW (lib/cfb_research_view.js), rule by rule.

   Every projection below carries the display fields the REAL engine computes:
   football/cfb_p4/engine.js is loaded and its fairLine.normalize() fills
   display_fair_spread / display_side / is_near_pickem, so a test can never
   pass on a display rule the engine does not ship.

   Run: node tools/football/cfb_research_view.test.js
   ========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const V = require(path.join(ROOT, 'lib', 'cfb_research_view.js'));
global.EDCfbP4Params = require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));

let checks = 0, failures = 0;
function chk(name, cond, detail) {
  checks++;
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { detail = String(e && e.stack || e).slice(0, 400); cond = false; } }
  if (cond) return;
  failures++; console.error('  FAIL: ' + name + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 400)));
}
function eq(name, got, want) { chk(name + ' (got ' + JSON.stringify(got) + ', wanted ' + JSON.stringify(want) + ')', got === want); }
function near(name, got, want, tol) { chk(name + ' (got ' + got + ', wanted ' + want + ')', got != null && Math.abs(got - want) <= (tol == null ? 1e-9 : tol)); }
function section(t) { console.log('\n' + t); }

const HOME = 'Florida', AWAY = 'Ole Miss';
const GAME = { game_id: 'G1', home: HOME, away: AWAY };

/* an engine-shaped projection at raw margin `raw`, with the engine's own
   display layer applied to it */
function proj(raw, o) {
  o = o || {};
  const fl = E.fairLine.normalize(raw, o.tiebreak || {});
  const p = {
    status: 'PREDICTED',
    game: { home: HOME, away: AWAY },
    model: {
      fair_spread: raw, fair_total: 52, home_win_prob: o.win_prob == null ? E.dist.winProb(raw, 15) : o.win_prob,
      display_fair_spread: fl.display_fair_spread, display_side: fl.display_side,
      is_near_pickem: fl.is_near_pickem, display_basis: fl.basis
    },
    scores: { confidence: o.conf === undefined ? 62 : o.conf },
    market: { spread_line: o.line == null ? null : o.line, spread_gap: o.line == null ? null : raw - o.line },
    contributions: o.contributions || [],
    explanation: { primary_drivers: [], counterarguments: [], data_quality: [] },
    layers: o.layers || {},
    data_quality: { status: 'OK', warnings: [] }
  };
  return p;
}

/* ======================================================================== */
section('STEP 1 · the fair line always names a side, with a one-point floor');
{
  const a = V.build({ game: GAME, projection: proj(-0.10) }).fair;
  eq('raw -0.10 (away by 0.10) displays at the one-point floor', a.display_fair_spread, -1);
  eq('on the away side', a.favorite_team, AWAY);
  eq('as "Ole Miss -1.0"', a.fair_line_text, AWAY + ' -1.0');
  eq('and it is flagged a near pick’em', a.is_near_pickem, true);
  near('while the raw margin is kept exactly', a.raw_projected_margin, -0.10);
  eq('and stated for the displayed side', a.raw_line_text, AWAY + ' -0.10');

  const b = V.build({ game: GAME, projection: proj(0.10) }).fair;
  eq('raw +0.10 (home by 0.10) displays at +1 (home margin)', b.display_fair_spread, 1);
  eq('named for the home side', b.fair_line_text, HOME + ' -1.0');
  eq('near pick’em', b.is_near_pickem, true);

  const z = V.build({ game: GAME, projection: proj(0, { tiebreak: { win_probability: 0, weighted_components: -0.4 } }) }).fair;
  eq('an exact tie takes the engine’s deterministic tiebreak', z.display_side, 'away');
  eq('and still shows a one-point line', z.display_fair_spread, -1);
  eq('with the tie stated, not hidden', /exact tie/.test(z.raw_line_text), true);
  eq('and the basis names the step that decided it', z.basis && z.basis.step, 'weighted_components');
  const z2 = V.build({ game: GAME, projection: proj(0, { tiebreak: { win_probability: 0, weighted_components: -0.4 } }) }).fair;
  eq('the tiebreak is deterministic: the same inputs name the same side', z2.fair_line_text, z.fair_line_text);
  const z3 = V.build({ game: GAME, projection: proj(0) }).fair;
  eq('with nothing measurable the engine’s labelled home convention is used', z3.display_side, 'home');

  const c = V.build({ game: GAME, projection: proj(-6.54) }).fair;
  eq('a clear favourite is the raw number itself', c.display_fair_spread, -6.54);
  eq('shown as the favourite laying it', c.fair_line_text, AWAY + ' -6.5');
  eq('and is not a near pick’em', c.is_near_pickem, false);

  /* no displayed fair line is ever PK, 0, -0.5 or +0.5 */
  const banned = [];
  for (let i = -300; i <= 300; i++) {
    const raw = i / 100, f = V.build({ game: GAME, projection: proj(raw) }).fair;
    if (/(PK| 0\.0| [+-]?0\.5)$/.test(f.fair_line_text) || Math.abs(f.display_fair_spread) < 1) banned.push(raw);
    if (raw !== 0 && ((raw > 0) !== (f.display_side === 'home'))) banned.push('flip ' + raw);
  }
  chk('no displayed fair line from -3.00 to +3.00 is PK, 0, ±0.5, or on the wrong side', !banned.length, banned.slice(0, 5));

  eq('a model that publishes no display line shows its raw number (NFL-style)',
    V.build({ game: GAME, projection: { status: 'PREDICTED', model: { fair_spread: 3.2 } } }).fair.fair_line_text, HOME + ' -3.2');
  eq('a projection that is not PREDICTED has no fair line', V.build({ game: GAME, projection: { status: 'INSUFFICIENT_DATA' } }).fair, null);
  eq('and no projection at all is not projected', V.build({ game: GAME }).projected, false);
}

console.log('\n' + (failures ? failures + ' of ' + checks + ' checks FAILED' : 'all ' + checks + ' checks passed'));
process.exit(failures ? 1 : 0);
