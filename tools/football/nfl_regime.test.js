#!/usr/bin/env node
/* ============================================================================
   THE NFL REGIME SIGNAL (audit 2026-09-30 follow-up #4).
     1  the signal (lib/nfl_regime.js): first-year coach, new starting QB,
        starting QB out — each known before kickoff
     2  the price: the shift formula, and forGame prices only when promoted
     3  the engine: a priced shift is its own spread term; an unpriced one is
        named and moves nothing
     4  the record (football/validation/nfl_regime.json) and this season's file
        agree with the rule they state
     5  the board's own module attaches it (fbNflGameReq) and prices it (fbPredict)

     node tools/football/nfl_regime.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { detail = String(e && e.stack || e).slice(0, 400); ok = false; } }
  if (ok) { pass++; return; }
  fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : ''));
}
function section(t) { console.log('  · ' + t); }
const near = (a, b, tol) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= (tol == null ? 1e-9 : tol);

const NR = require(path.join(ROOT, 'lib', 'nfl_regime.js'));

/* a two-season schedule for one club, AAA, against rotating opponents */
function row(season, week, day, home, away, hq, aq, hc, ac, played) {
  return { game_id: season + '_' + String(week).padStart(2, '0') + '_' + away + '_' + home, season: String(season), week: String(week), gameday: day,
    home_team: home, away_team: away, result: played ? '3' : '', home_qb_id: hq, away_qb_id: aq, home_qb_name: hq, away_qb_name: aq, home_coach: hc, away_coach: ac };
}
const ROWS = [
  row(2025, 1, '2025-09-07', 'AAA', 'B1', 'qbA', 'x1', 'Coach Old', 'c1', true),
  row(2025, 2, '2025-09-14', 'AAA', 'B2', 'qbA', 'x2', 'Coach Old', 'c2', true),
  row(2025, 3, '2025-09-21', 'AAA', 'B3', 'qbA', 'x3', 'Coach Old', 'c3', true),
  row(2026, 1, '2026-09-10', 'AAA', 'B1', 'qbN', 'x1', 'Coach New', 'c1', true),     /* new coach, new QB */
  row(2026, 2, '2026-09-17', 'AAA', 'B2', 'qbN', 'x2', 'Coach New', 'c2', true),
  row(2026, 3, '2026-09-24', 'AAA', 'B3', 'qbBackup', 'x3', 'Coach New', 'c3', false) /* the starter out */
];

section('1. the signal');
{
  const S = NR.signals(ROWS);
  const w1 = S['2026_01_B1_AAA|home'], w3 = S['2026_03_B3_AAA|home'], w25 = S['2025_02_B2_AAA|home'];
  chk('a first-year head coach reads coach = 1, against the coach of the club\'s last game last season', w1.f.coach === 1 && w1.prev_coach === 'Coach Old');
  chk('a starter who is not last season\'s primary QB reads new_qb = 1', w1.f.new_qb === 1 && w1.prev_primary_qb === 'qbA');
  chk('before the club has started anyone this season there is no established starter, so qb_out = 0', w1.f.qb_out === 0 && w1.established_qb === null);
  chk('a starter who is not the established one this season reads qb_out = 1 (and games this season counts only played games)', w3.f.qb_out === 1 && w3.established_qb === 'qbN' && w3.games_this_season === 2);
  chk('the same coach and QB read all zeros', w25.f.coach === 0 && w25.f.new_qb === 0 && w25.f.qb_out === 0);
  chk('a club with no history reads zeros, never a guess', (() => { const s = S['2025_01_B1_AAA|away']; return s.f.coach === 0 && s.f.new_qb === 0 && s.f.qb_out === 0; })());
  const S2 = NR.signals(ROWS.concat([row(2026, 4, '2026-10-01', 'AAA', 'B4', 'qbBackup', 'x4', 'Coach New', 'c4', false)]));
  chk('an UPCOMING start never enters the counts a later game is judged against (week 3 is unplayed, so week 4 still reads qbN established)',
    S2['2026_04_B4_AAA|home'].established_qb === 'qbN' && S2['2026_04_B4_AAA|home'].f.qb_out === 1 && S2['2026_04_B4_AAA|home'].games_this_season === 2);
}

section('2. the price');
{
  const b = { coach: -1.75, new_qb: -1.25, qb_out: -3, lambda: 0.1 };
  chk('shift = (coach·b + new_qb·b)·exp(−λ·games) + qb_out·b', near(NR.shiftOf({ coach: 1, new_qb: 1, qb_out: 1 }, 2, b), (-1.75 - 1.25) * Math.exp(-0.2) - 3, 1e-12));
  const S = NR.signals(ROWS);
  const unpriced = NR.forGame(S, '2026_03_B3_AAA', { promoted: false, shipped: { coef: b } });
  const priced = NR.forGame(S, '2026_03_B3_AAA', { promoted: true, shipped: { coef: b } });
  chk('forGame is priced only when the record is promoted, and carries the shift and the reason either way', unpriced.priced === false && priced.priced === true
    && near(priced.home.shift_points, NR.shiftOf(S['2026_03_B3_AAA|home'].f, 2, b), 1e-3) && /starting QB out/.test(priced.home.why));
  chk('no record, no price', NR.forGame(S, '2026_03_B3_AAA', null).priced === false);
}

section('3. the engine');
{
  require(path.join(ROOT, 'football', 'params.js'));
  const E = require(path.join(ROOT, 'football', 'engine.js'));
  const st = E.nfl.newState(), g = { home: 'SEA', away: 'LAC', week: 4 };
  const base = E.predictGame({ sport: 'nfl', state: st, game: g, season: 2026 });
  const rg = (priced) => ({ priced, home: { flagged: true, shift_points: -1.25, why: 'new starting QB: Drew Lock' }, away: { flagged: false, shift_points: 0, why: null } });
  const on = E.predictGame({ sport: 'nfl', state: st, game: Object.assign({}, g, { regime: rg(true) }), season: 2026 });
  const off = E.predictGame({ sport: 'nfl', state: st, game: Object.assign({}, g, { regime: rg(false) }), season: 2026 });
  chk('a priced shift moves the fair spread by exactly shift_home − shift_away, as its own "regime" term', near(on.model.fair_spread - base.model.fair_spread, -1.25, 1e-12)
    && on.contributions.spread.some((t) => t.key === 'regime' && t.points === -1.25));
  chk('…and names it in the data-quality warnings', on.data_quality.warnings.some((w) => /^NFL REGIME \(SEA\): new starting QB: Drew Lock — priced -1\.25 pts/.test(w)));
  chk('an UNPRICED signal moves nothing and says "research only"', off.model.fair_spread === base.model.fair_spread && !off.contributions.spread.some((t) => t.key === 'regime')
    && off.data_quality.warnings.some((w) => /research only, not priced/.test(w)));
}

section('4. the record and this season\'s file');
{
  const REC = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'validation', 'nfl_regime.json'), 'utf8'));
  const P = REC.walk_forward.pooled;
  chk('expanding window: every scored season 2019-2025 fitted on 2016..S−1 only', REC.walk_forward.by_season.every((s) => s.fitted_on === '2016-' + (s.season - 1)) && REC.walk_forward.by_season[0].season === 2019);
  chk('promoted exactly when the pooled held-out gain clears 0.05 with a CI excluding zero (the declared rule)',
    REC.promoted === (P.delta <= -REC.rules.promote_min_gain && P.delta_ci95[1] < 0), [REC.promoted, P]);
  chk('the market is not an input, and the engine it tests was frozen on seasons <= 2015', REC.market_is_an_input === false && REC.engine_frozen_through === 2015);
  const CUR = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'nfl', 'regime_2026.json'), 'utf8'));
  chk('this season\'s file carries the shipped coefficients and the record\'s verdict', CUR.priced === REC.promoted && JSON.stringify(CUR.coef) === JSON.stringify(REC.shipped.coef));
  chk('every club\'s shift is the formula over its own flags', Object.values(CUR.by_team).every((t) => near(t.shift_points,
    Math.round(NR.shiftOf({ coach: +t.new_coach, new_qb: +t.new_qb, qb_out: +t.qb_out }, t.games_this_season, CUR.coef) * 1000) / 1000, 1e-9)));
  chk('a flagged club says why; an unflagged one has no shift', Object.values(CUR.by_team).every((t) => (t.regime ? !!t.why : t.shift_points === 0 && t.why === null)));
}

section('5. the board prices it through its own module');
{
  const M = require(path.join(__dirname, '_module.js'));
  const B = M.boot({ probe: ['fbNflGameReq', 'fbPredict', 'fbNflRegimeFor'] });
  if (B.error) { chk('the football module boots', false, String(B.error)); }
  else {
    const win = B.win; M.loadNflEngine(win, ROOT); const T = win.__FBTEST;
    chk('the harness loads the signal the page\'s <script> tag loads', !!win.EDNflRegime && /lib\/nfl_regime\.js/.test(fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8')));
    win.FB.nfl.regimeSig = NR.signals(ROWS);
    win.FB.nfl.regimeFit = { schema: 'edgedesk_nfl_regime_v1', promoted: true, shipped: { coef: { coach: -1.75, new_qb: -1.25, qb_out: -3, lambda: 0 } } };
    const g = { game_id: '2026_03_B3_AAA', home_team: 'AAA', away_team: 'B3', week: '3' };
    const req = T.fbNflGameReq(g);
    chk('fbNflGameReq attaches the game\'s regime, priced as the record says', req.regime && req.regime.priced === true && near(req.regime.home.shift_points, -1.75 - 1.25 - 3, 1e-9));
    win.FB.nfl.state = win.EDFootball.nfl.newState();
    const withR = T.fbPredict('nfl', req, {}, 2026), without = T.fbPredict('nfl', Object.assign({}, req, { regime: null }), {}, 2026);
    chk('fbPredict prices it: the board\'s fair spread moves by the shift', withR.status === 'PREDICTED' && near(withR.model.fair_spread - without.model.fair_spread, -6, 1e-9),
      [withR.status, withR.model && withR.model.fair_spread, without.model && without.model.fair_spread]);
    win.FB.nfl.regimeSig = null;
    chk('without the signal loaded the request carries none (the number is the engine\'s alone)', T.fbNflGameReq(g).regime === null);
  }
}

console.log((fail ? 'FAILED ' : 'ALL GREEN ') + 'NFL regime — ' + pass + ' passed, ' + fail + ' failed');
if (fail) { failures.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
