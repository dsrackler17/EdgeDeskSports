#!/usr/bin/env node
/* ============================================================================
   THE REGIME CHANGE (audit 2026-09-30 #1).

   Iowa State (Matt Campbell to Penn State, Jimmy Rogers in, the roster out
   with Campbell) and North Texas (Eric Morris and the roster to Oklahoma
   State) were priced 12+ points off the market by a pricing state that was
   still ~80% the long-run rating of the team that left. The fix, and what
   this file pins:

     1  the signal (football/coaching/regime_signal.js): a new head coach AND
        a roster that turned over; an unknown coach change is not a change
     2  the coach table walk-back (football/coaching/build_coaching.js): a
        programme whose previous-season row is missing, coached by last
        season's head coach of another programme, is a new-coach season
     3  the curve (football/cfb_p4/regime_curve.js): fitted walk-forward on
        past coaching-change seasons, never steeper than its own held-out
        record allows, and never above the standard curve
     4  the engine (football/cfb_p4/engine.js): a regime side's long-run
        state is weighted on the regime curve, the shift is exactly
        (w_regime - w_standard) x (long-run - this season), and the
        projection says so in its data-quality warnings
     5  the contract (football/matchup/contract.js regimeFor): only a fired
        signal reaches the engine
     6  the research gate (lib/edgedesk_canon.js): REGIME CHANGE blocks
        WORTH RESEARCHING and VERIFIED MAJOR until the team has played N
        games this season, and names the team and the count
     7  the current season's record (football/coaching/regime.json): Iowa
        State and North Texas fire, with their reasons; the hand-maintained
        overrides refuse an unsourced or undated entry

     node tools/football/regime.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
global.window = global.window || global;

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { detail = String(e && e.stack || e).slice(0, 400); ok = false; } }
  if (ok) { pass++; return; }
  fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : ''));
}
function section(t) { console.log('  · ' + t); }
const near = (a, b, tol) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) <= (tol == null ? 1e-9 : tol);

const RS = require(path.join(ROOT, 'football', 'coaching', 'regime_signal.js'));
const BC = require(path.join(ROOT, 'football', 'coaching', 'build_coaching.js'));
const BR = require(path.join(ROOT, 'football', 'coaching', 'build_regime.js'));
const CURVE = require(path.join(ROOT, 'football', 'cfb_p4', 'regime_curve.js'));
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
const CONTRACT = require(path.join(ROOT, 'football', 'matchup', 'contract.js'));
const C = require(path.join(ROOT, 'lib', 'edgedesk_canon.js'));

/* ======================================================================== */
section('1. the signal');
chk('a new head coach with a below-median returning share fires', RS.fires({ new_hc: true, returning_share_pct: 0.2 }).fires === true);
chk('…and names what fired it', /returning roster share at the 20th percentile/.test(RS.fires({ new_hc: true, returning_share_pct: 0.2 }).reason));
chk('a new head coach whose roster came back does not fire', RS.fires({ new_hc: true, returning_share_pct: 0.8, returning_production_pct: 0.7, transfers_out_pct: 0.3 }).fires === false);
chk('heavy portal outflow alone (75th percentile) fires with a new coach', RS.fires({ new_hc: true, returning_share_pct: 0.7, transfers_out_pct: 0.8 }).fires === true);
chk('the same coach never fires, whatever the roster did', RS.fires({ new_hc: false, returning_share_pct: 0.01, transfers_out_pct: 0.99 }).fires === false);
chk('an UNKNOWN coach change never fires: silence is not a regime change', RS.fires({ new_hc: null, returning_share_pct: 0.01 }).fires === false);
chk('a coach change with no continuity measured fires on the coach change alone (the conservative direction: the flag blocks labels, it never creates one)',
  RS.fires({ new_hc: true }).fires === true && /coach change alone/.test(RS.fires({ new_hc: true }).reason));
chk('percentiles are ranks within the season, ties averaged, and need a real field (20+)', (() => {
  const xs = []; for (let i = 0; i < 40; i++) xs.push(i < 20 ? 0.3 : 0.6);
  const p = RS.percentiles(xs);
  return near(p(0.3), 10.5 / 40, 1e-9) && near(p(0.6), 30.5 / 40, 1e-9) && RS.percentiles([0.1, 0.2])(0.1) === null;
})());
chk('ordinals read 1st / 2nd / 3rd / 11th / 21st', /1st percentile/.test(RS.fires({ new_hc: true, returning_share_pct: 0.01 }).reason)
  && /2nd percentile/.test(RS.fires({ new_hc: true, returning_share_pct: 0.02 }).reason) && /3rd percentile/.test(RS.fires({ new_hc: true, returning_share_pct: 0.03 }).reason)
  && /11th percentile/.test(RS.fires({ new_hc: true, returning_share_pct: 0.11 }).reason) && /21st percentile/.test(RS.fires({ new_hc: true, returning_share_pct: 0.21 }).reason));

/* ======================================================================== */
section('2. the coach table walk-back');
{
  const T = { 2025: { 10: { coach: 'Matt Campbell', team: 'Iowa State' }, 20: { coach: 'Someone Else', team: 'Other' } },
    2026: { 30: { coach: 'Matt Campbell', team: 'Penn State' }, 10: { coach: 'Jimmy Rogers', team: 'Iowa State' } } };
  const ps = BC.walkBack(T, 30, T[2026][30], 2026, 2020);
  chk('a programme with no previous-season row, coached by last season\'s head coach elsewhere, is a new-coach season', ps.new_hc === true && ps.hc_elsewhere && ps.hc_elsewhere.team === 'Iowa State' && /Matt Campbell was head coach of Iowa State in 2025/.test(ps.basis), ps);
  const isu = BC.walkBack(T, 10, T[2026][10], 2026, 2020);
  chk('a changed coach on a continuous row is a new-coach season', isu.new_hc === true && /changed from last season/.test(isu.basis), isu);
  const T2 = { 2024: { 5: { coach: 'A' } }, 2025: { 5: { coach: 'A' } }, 2026: { 5: { coach: 'A' } } };
  chk('the same coach two seasons running is not', BC.walkBack(T2, 5, T2[2026][5], 2026, 2020).new_hc === false);
  const T3 = { 2025: { 9: { coach: 'Nobody Here' } }, 2026: { 7: { coach: 'Brand New' } } };
  chk('nothing in the table settles it: unknown (null), never a guess either way', BC.walkBack(T3, 7, T3[2026][7], 2026, 2020).new_hc === null);
}

/* ======================================================================== */
section('3. the fitted curve');
chk('the curve artifact names its version, its signal and its N', CURVE.version === 'cfb_regime_curve_v1' && CURVE.signal && CURVE.signal.id === RS.DEFAULT.id && Number.isInteger(CURVE.min_games_for_research) && CURVE.min_games_for_research >= 1);
chk('it was fitted walk-forward and its held-out record IMPROVED the error (delta < 0, the 95% interval below 0)',
  CURVE.record && CURVE.record.walk_forward_window && CURVE.record.delta < 0 && CURVE.record.delta_ci95[1] < 0, CURVE.record);
chk('w0 and lambda sit inside the grid the fit searched (never hand-tuned outside it)', CURVE.curve.w0 >= 0.2 && CURVE.curve.w0 <= 1 && CURVE.curve.lambda >= 0 && CURVE.curve.lambda <= 0.6);
chk('the report the artifact cites exists', fs.existsSync(path.join(ROOT, CURVE.report)));
chk('the regime weight never exceeds the standard curve at any game count', [0, 1, 3, 6, 10, 15].every((g) => { const std = 0.9 - 0.02 * g; const w = RS.weight(g, std, CURVE.curve); return w <= std + 1e-12; }));
chk('the curve table agrees with the formula it states', Object.keys(CURVE.curve.table).every((g) => {
  const tw = CURVE.curve.table[g];
  return tw <= CURVE.curve.w0 * Math.exp(-CURVE.curve.lambda * +g) + 1e-4;
}));

/* ======================================================================== */
section('4. the engine applies it');
{
  const st = E.newState();
  E.ingest.seasonBreak(st);
  for (let i = 0; i < 4; i++) {
    E.ingest.absorbGame(st, { home: 'Iowa State', away: 'Kansas', home_fbs: true, away_fbs: true, home_points: 17, away_points: 31 });
    E.ingest.absorbGame(st, { home: 'West Virginia', away: 'Baylor', home_fbs: true, away_fbs: true, home_points: 24, away_points: 21 });
  }
  const kick = new Date(Date.now() + 3 * 86400e3).toISOString();
  const req = (regime) => ({ season: 2026, week: 5, state: st, game: { home: 'Iowa State', away: 'West Virginia', home_fbs: true, away_fbs: true, neutral_site: false, kickoff: kick },
    teams: { home: { conference: 'Big 12', regime: regime || null }, away: { conference: 'Big 12' } } });
  const base = E.projectGame(req(null));
  const R = { regime_change: true, reason: 'new head coach; returning production at the 1st percentile', team: 'Iowa State', min_games_for_research: CURVE.min_games_for_research };
  const reg = E.projectGame(req(R));
  const S0 = base.layers.strength, S1 = reg.layers.strength, B0 = S0.preseason_blend, B1 = S1.preseason_blend;
  chk('without the signal nothing moves: no regime state on either side', S0.regime && S0.regime.home === null && S0.regime.away === null, S0.regime);
  chk('with it, the home side is weighted on the regime curve (applied) and says why', S1.regime.home && S1.regime.home.applied === true && /REGIME CHANGE/.test(S1.regime.home.why) && S1.regime.away === null, S1.regime);
  chk('the regime weight is the curve at the games played, capped by the standard weight',
    near(B1.home_prior_weight, Math.min(B1.home_standard_prior_weight, CURVE.curve.w0 * Math.exp(-CURVE.curve.lambda * S1.regime.home.games_played)), 1e-6) && B1.home_prior_weight < B1.home_standard_prior_weight,
    [B1.home_prior_weight, B1.home_standard_prior_weight, S1.regime.home]);
  chk('the away side keeps the standard weight exactly', near(B1.away_prior_weight, B0.away_prior_weight, 1e-12));
  chk('the fair margin moves by exactly (w_regime - w_standard) x (long-run - this season), and by nothing else',
    near(reg.model.fair_spread - base.model.fair_spread, (B1.home_prior_weight - B1.home_standard_prior_weight) * (B1.home_carried - B1.home_this_season), 1e-6),
    [reg.model.fair_spread - base.model.fair_spread, (B1.home_prior_weight - B1.home_standard_prior_weight) * (B1.home_carried - B1.home_this_season)]);
  chk('the projection names the flag in its data-quality warnings', (reg.data_quality && (reg.data_quality.warnings || []).some((w) => /REGIME CHANGE \(Iowa State\)/.test(w))), reg.data_quality);
  chk('the flag carries the games played and the N the research gate waits for', S1.regime.home.games_played === 4 && S1.regime.home.min_games_for_research === CURVE.min_games_for_research);
  chk('a regime curve that is not loaded keeps the standard weight but still flags (curve_override=null path)', (() => {
    const cached = global.window.EDCfbP4RegimeCurve; global.window.EDCfbP4RegimeCurve = undefined;
    try {
      const r = E.projectGame(req(Object.assign({}, R, { curve_override: { w0: null, lambda: null } })));
      return r.layers.strength.regime.home && r.layers.strength.regime.home.applied === false && near(r.layers.strength.preseason_blend.home_prior_weight, B0.home_prior_weight, 1e-12);
    } finally { global.window.EDCfbP4RegimeCurve = cached; }
  })());
}

/* ======================================================================== */
section('5. the contract');
chk('regimeFor passes a fired signal', (() => { const r = CONTRACT.regimeFor({ iowastate: { regime_change: true, reason: 'x', team: 'Iowa State', min_games_for_research: 6 } }, 'iowastate'); return r && r.regime_change === true && r.min_games_for_research === 6; })());
chk('…and nothing for a programme that did not fire, or is not in the record', CONTRACT.regimeFor({ kansas: { regime_change: false } }, 'kansas') === null && CONTRACT.regimeFor({}, 'nobody') === null);

/* ======================================================================== */
section('6. the research gate');
{
  const base = { projected: true, market: 'FRESH', confidence: 70, reliability: 80, fair_margin: 8, market_margin: 4.5, gap: 3.5, team_names: { home: 'Iowa State', away: 'West Virginia' } };
  const reg = (g) => ({ home: { regime_change: true, games_played: g, min_games_for_research: 6, reason: 'new head coach; returning production at the 1st percentile' }, away: null });
  const a = C.researchStatus(Object.assign({}, base, { regime: reg(4) }));
  chk('a 3.5-pt gap on a regime team with 4 of 6 games: INVESTIGATE, never WORTH RESEARCHING', a.key === 'INVESTIGATE' && a.rule === 'regime_change' && a.blocked === 'WORTH_RESEARCHING', a);
  chk('…naming the team, the reason and the count', /REGIME CHANGE: Iowa State \(new head coach; returning production at the 1st percentile; 4 of 6 games needed this season\)/.test(a.reason), a.reason);
  chk('…and carrying the REGIME CHANGE flag', (a.flags || []).some((f) => f.key === 'REGIME_CHANGE'));
  chk('at 6 games the block lifts: WORTH RESEARCHING', C.researchStatus(Object.assign({}, base, { regime: reg(6) })).key === 'WORTH_RESEARCHING');
  const v = C.researchStatus(Object.assign({}, base, { gap: 12, market_margin: 20, verification: 'VERIFIED', regime: reg(4) }));
  chk('a VERIFIED 12-pt gap on a regime team is INVESTIGATE (blocked VERIFIED MAJOR)', v.key === 'INVESTIGATE' && v.blocked === 'VERIFIED_MAJOR', v);
  const u = C.researchStatus(Object.assign({}, base, { gap: 12, market_margin: 20, regime: reg(4) }));
  chk('an unverified one stays INVESTIGATE and says both', u.key === 'INVESTIGATE' && /REGIME CHANGE/.test(u.reason) && /integrity gate/.test(u.reason), u.reason);
  chk('the flag never CREATES a label: an aligned game on a regime team stays MARKET ALIGNED', C.researchStatus(Object.assign({}, base, { gap: 0.8, fair_margin: 5.3, regime: reg(2) })).key === 'MARKET_ALIGNED');
  chk('the gate does not loosen anything: unmeasured reliability is still LIMITED DATA before any regime reasoning', C.researchStatus(Object.assign({}, base, { reliability: null, regime: reg(4) })).key === 'LIMITED_DATA');
}

/* ======================================================================== */
section('7. the current season\'s record');
{
  const RJ = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'coaching', 'regime.json'), 'utf8'));
  const by = (name) => Object.values(RJ.by_team).find((t) => t.team && t.team.indexOf(name) === 0);
  chk('the record is for the current season, with the curve\'s N', RJ.schema === 'edgedesk_regime_change_v1' && RJ.season === 2026 && RJ.min_games_for_research === CURVE.min_games_for_research);
  const isu = by('Iowa State'), unt = by('North Texas');
  chk('Iowa State fires: new head coach and returning production far under the season median', isu && isu.regime_change === true && isu.new_hc === true && /new head coach/.test(isu.reason), isu && { r: isu.reason, rp: isu.returning_production, hc: isu.hc });
  chk('North Texas fires', unt && unt.regime_change === true && unt.new_hc === true, unt && { r: unt.reason, hc: unt.hc });
  chk('Penn State fires (the walk-back: its 2025 row was missing)', by('Penn State') && by('Penn State').regime_change === true);
  chk('a programme that kept its coach does not fire (West Virginia, Tulsa)', ['West Virginia', 'Tulsa'].every((n) => !by(n) || by(n).regime_change === false), ['West Virginia', 'Tulsa'].map((n) => by(n) && [by(n).new_hc, by(n).reason]));
  chk('every fired team carries its N and a reason', Object.values(RJ.by_team).filter((t) => t.regime_change).every((t) => t.min_games_for_research === RJ.min_games_for_research && t.reason));
  chk('the unknowns are counted, not guessed', RJ.counts.new_hc_unknown >= 0 && Object.values(RJ.by_team).filter((t) => t.new_hc == null).every((t) => t.regime_change === false));
  const ov = BR.loadOverrides(2026);
  chk('the committed overrides all load (each carries a source and a date)', ov.refused.length === 0 && Object.keys(ov.by_key).length >= 1, ov.refused);
  chk('Virginia Tech is a new-coach season by override, citing its source', by('Virginia Tech') && by('Virginia Tech').new_hc === true && /^override: https?:\/\//.test(by('Virginia Tech').new_hc_basis || ''));
}
{
  /* the override table refuses what cannot be audited */
  const tmp = path.join(ROOT, 'football', 'coaching', 'regime_overrides.json');
  const orig = fs.readFileSync(tmp, 'utf8');
  try {
    const t = JSON.parse(orig);
    t.entries = t.entries.concat([{ team: 'Nowhere State', season: 2026, new_coach: true, returning_production_pct: null, source: '', entered_at: '2026-09-30' },
      { team: 'Undated U', season: 2026, new_coach: true, returning_production_pct: null, source: 'https://example.org', entered_at: 'yesterday' },
      { team: 'Bad Pct', season: 2026, new_coach: null, returning_production_pct: 140, source: 'https://example.org', entered_at: '2026-09-30' }]);
    fs.writeFileSync(tmp, JSON.stringify(t));
    const ov = BR.loadOverrides(2026);
    chk('an override without a source, without a valid date, or with a percentage outside 0-100 is refused and listed',
      ov.refused.length === 3 && ov.refused.map((x) => x.why).join('|') === 'no source|no valid entered_at date|returning_production_pct must be a number from 0 to 100', ov.refused);
  } finally { fs.writeFileSync(tmp, orig); }
}

/* ======================================================================== */
section('8. the published slate carries what the engine applied');
{
  const SL = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'fbs', 'slate.json'), 'utf8'));
  const withRegime = (SL.games || []).filter((g) => g.regime);
  const regimeTeams = new Set(Object.values(JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'coaching', 'regime.json'), 'utf8')).by_team).filter((t) => t.regime_change).map((t) => t.key));
  const NK = require(path.join(ROOT, 'football', 'fbs', 'fbs.js')).normKey;
  const shouldHave = (SL.games || []).filter((g) => g.model_status === 'PREDICTED' && (regimeTeams.has(NK(g.home_team)) || regimeTeams.has(NK(g.away_team))));
  chk('every predicted slate game with a regime team carries the regime state, applied — and no other game does',
    shouldHave.length > 0 && withRegime.length === shouldHave.length && withRegime.every((g) => (g.regime.home && g.regime.home.applied) || (g.regime.away && g.regime.away.applied)),
    { with_regime: withRegime.length, should: shouldHave.length });
}

console.log((fail ? 'FAILED ' : 'ALL GREEN ') + 'regime change — ' + pass + ' passed, ' + fail + ' failed');
if (fail) { failures.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
