#!/usr/bin/env node
/* ============================================================================
   HOME/AWAY ORIENTATION AND THE INDEPENDENTS (audit 2026-09-30 #5).

   Syracuse @ UConn: EdgeDesk UConn -12.2 against a Syracuse -7.5 market. The
   join was oriented correctly (UConn hosts at Pratt & Whitney Stadium and the
   captured event resolves home/away strictly). The number was not: the
   engine's conference-strength term treated "FBS Independents" as a
   conference, and its 2025 cross-conference strength (+15.2, carried by Notre
   Dame) handed UConn +3.8 pts over every ACC team. On top of that, UConn is in
   a regime change (returning production ~2%, audit #1).

     1  an independent carries no conference strength (football/cfb_p4/engine.js)
     2  the conference term still applies between two conferences
     3  THE INVARIANT (lib/edgedesk_canon.js orientationSuspect): a gap over 10
        pts that flipping the model's sign would bring under 5 is a DATA FAULT
        "possible orientation flip", excluded from ranking until resolved;
        only a verified gap is exempt
     4  the NFL board applies the same invariant (app.html fbNflResearchState)
     5  the published slate: Syracuse @ UConn carries no conference term

     node tools/football/orientation.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global.window || global;

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { detail = String(e && e.stack || e).slice(0, 400); ok = false; } }
  if (ok) { pass++; return; }
  fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : ''));
}
function section(t) { console.log('  · ' + t); }

require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
const C = require(path.join(ROOT, 'lib', 'edgedesk_canon.js'));
const P = global.window.EDCfbP4Params;

/* ======================================================================== */
section('1-2. the conference term');
{
  const st = E.newState();
  E.ingest.seasonBreak(st);
  for (let i = 0; i < 2; i++) {
    E.ingest.absorbGame(st, { home: 'UConn', away: 'Buffalo', home_fbs: true, away_fbs: true, home_points: 24, away_points: 20 });
    E.ingest.absorbGame(st, { home: 'Syracuse', away: 'Temple', home_fbs: true, away_fbs: true, home_points: 17, away_points: 21 });
  }
  const kick = new Date(Date.now() + 3 * 86400e3).toISOString();
  const proj = (hc, ac) => E.projectGame({ season: 2026, week: 5, state: st,
    game: { home: 'UConn', away: 'Syracuse', home_fbs: true, away_fbs: true, neutral_site: false, kickoff: kick },
    teams: { home: { conference: hc }, away: { conference: ac } } });
  const term = (p) => (p.explanation && p.explanation.terms ? p.explanation.terms : []).filter((t) => t.key === 'conference')[0] || null;
  const ind = proj('FBS Independents', 'ACC');
  const S = (p) => p.layers.situation;
  chk('an independent carries no conference strength: the term is unavailable, and says why', S(ind).conference_home.available === false
    && /an independent has no conference/.test(S(ind).conference_home.reason || ''), S(ind).conference_home);
  const D = require(path.join(ROOT, 'lib', 'cfb_disagreement.js'));
  chk('…so the conference component of the fair margin is 0', D.fromEngine(ind).components.conference === 0);
  const withConf = proj('American Athletic', 'ACC');
  chk('two conferences still get the term (American vs ACC, early season)', S(withConf).conference_home.available === true && S(withConf).conference_away.available === true && D.fromEngine(withConf).components.conference !== 0);
  const old = (() => { P.conference.independents_as_conference = true; try { return proj('FBS Independents', 'ACC'); } finally { delete P.conference.independents_as_conference; } })();
  const dFair = old.model.fair_spread - ind.model.fair_spread;
  const expected = P.conference.points_per_strength * (P.conference.by_season['2025']['FBS Independents'].strength - P.conference.by_season['2025'].ACC.strength)
    * Math.max(0, Math.min(1, 1 - 2 / 6));
  chk('the old reading gave the independent exactly the 2025 "Independents" strength gap (the audit\'s +3.8 at 3 games, here at 2)', Math.abs(dFair - expected) < 1e-6, [dFair, expected]);
  chk('the 2025 "FBS Independents" strength that did it was the highest of any group', (() => {
    const t = P.conference.by_season['2025']; const top = Object.keys(t).sort((a, b) => t[b].strength - t[a].strength)[0];
    return top === 'FBS Independents';
  })());
}

/* ======================================================================== */
section('3. the orientation invariant');
{
  const base = { projected: true, market: 'FRESH', confidence: 70, reliability: 80, team_names: { home: 'UConn', away: 'Syracuse' } };
  /* the audit numbers: model UConn -12.2 (home margin +12.2), market Syracuse -7.5 (home margin -7.5) */
  const a = C.researchStatus(Object.assign({}, base, { fair_margin: 12.2, market_margin: -7.5, gap: 19.7 }));
  chk('Syracuse @ UConn as audited: DATA FAULT "possible orientation flip", excluded from ranking', a.key === 'DATA_FAULT' && a.rule === 'orientation_flip' && a.rankable === false && /possible orientation flip/.test(a.reason), a);
  chk('…and it reports both gaps: as joined, and with the model\'s side flipped', a.orientation && a.orientation.gap === 19.7 && Math.abs(a.orientation.gap_if_flipped - 4.7) < 1e-9, a.orientation);
  const fixed = C.researchStatus(Object.assign({}, base, { fair_margin: 7.74, market_margin: -7.5, gap: 15.24 }));
  chk('after the independents and regime fixes (UConn -7.7) the game is STILL flagged: a 15-pt gap that flips to 0.2 is not explained by anything EdgeDesk holds', fixed.key === 'DATA_FAULT' && fixed.rule === 'orientation_flip', fixed);
  chk('a big gap that does NOT reconcile when flipped is not an orientation fault (12 pts, 6 when flipped)', C.researchStatus(Object.assign({}, base, { fair_margin: 9, market_margin: -3, gap: 12 })).rule !== 'orientation_flip');
  chk('a gap of 10 or less is never read as a flip', C.researchStatus(Object.assign({}, base, { fair_margin: 5, market_margin: -5, gap: 10 })).rule !== 'orientation_flip');
  chk('only a VERIFIED gap is exempt (the integrity gate checked the orientation)', C.researchStatus(Object.assign({}, base, { fair_margin: 12.2, market_margin: -7.5, gap: 19.7, verification: 'VERIFIED' })).rule !== 'orientation_flip');
  chk('the thresholds are the canon\'s (10 / 5)', C.THRESHOLDS.orientation_gap === 10 && C.THRESHOLDS.orientation_flipped_max === 5);
  chk('a stale market is still checked (the flip is in the join, not the price)', C.researchStatus(Object.assign({}, base, { market: 'STALE', fair_margin: 12.2, market_margin: -7.5, gap: 19.7 })).rule === 'orientation_flip');
}

/* ======================================================================== */
section('4. the NFL board reads the same invariant');
{
  const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
  const at = APP.indexOf('\nfunction fbNflResearchState(');
  const src = APP.slice(at + 1, APP.indexOf('\n}\n', at) + 3);
  const ctx = { window: { EDCanon: C }, FB_GUARD: { nfl: { game: 14 } }, Math };
  ctx.window.FB_GUARD = ctx.FB_GUARD;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const p = { status: 'PREDICTED', model: { fair_spread: 12 }, market: { spread_gap: 12 - (-8) } };
  const s = ctx.fbNflResearchState(p, { spread_line: -8 }, null);
  chk('an NFL game 20 pts off that reconciles when flipped is DATA FAULT · orientation flip', s.label === 'DATA FAULT' && s.rule === 'orientation_flip', s);
}

/* ======================================================================== */
section('5. the published slate');
{
  const SL = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'fbs', 'slate.json'), 'utf8'));
  const g = (SL.games || []).find((x) => x.home_team === 'UConn' && x.away_team === 'Syracuse');
  if (!g) chk('Syracuse @ UConn is no longer on the published slate (the check is moot this week)', true);
  else {
    const pr = g.disagreement_inputs && g.disagreement_inputs.projection;
    chk('Syracuse @ UConn: the published projection carries no conference term', pr && pr.components && pr.components.conference === 0, pr && pr.components);
  }
}

console.log((fail ? 'FAILED ' : 'ALL GREEN ') + 'orientation — ' + pass + ' passed, ' + fail + ' failed');
if (fail) { failures.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
