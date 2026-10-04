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
/* CORRECTED (second follow-up): this record was first published with a 95%
   interval of [-0.063, -0.006]. Its bootstrap generator, (seed * 1103515245 +
   12345) % 2^31 in doubles, cycled after ~10,466 draws, so every resample of
   2,203 games re-read nearly the same sequence. Re-run with an exact 32-bit
   generator the interval is [-0.095, +0.033]: the gain is NOT significant.
   What is pinned now is the honest form: the record carries its interval and
   a significance flag that agrees with it (a claim that is untrue fails). */
chk('it was fitted walk-forward; its held-out record carries its interval and states its significance from it',
  CURVE.record && CURVE.record.walk_forward_window && CURVE.record.delta < 0 && Array.isArray(CURVE.record.delta_ci95)
    && CURVE.record.significant === (CURVE.record.delta_ci95[1] < 0), CURVE.record);
chk('…and it says it plainly: the first-pass curve\'s gain is not significant (the interval includes zero)', CURVE.record.significant === false, CURVE.record);
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

/* ======================================================================== */
section('9. v2: the continuous turnover magnitude (a CANDIDATE, not priced)');
{
  const F = RS.magnitudeFeatures;
  chk('each hinge is zero at or better than the season median, and 1 at the extreme', F({ returning_production_pct: 0.5, incoming_production_pct: 0.5 }).prod === 0
    && F({ returning_production_pct: 0.9 }).prod === 0 && F({ returning_production_pct: 0 }).prod === 1 && F({ incoming_production_pct: 1 }).port === 1
    && F({ incoming_production_pct: 0.2 }).port === 0 && near(F({ returning_production_pct: 0.25 }).prod, 0.5));
  chk('coach and QB are 0/1, and an UNMEASURED input is 0 (silence is not turnover)', (() => {
    const z = F({}); return z.coach === 0 && z.prod === 0 && z.qb === 0 && z.port === 0 && F({ new_hc: true, qb_change: true }).coach === 1 && F({ qb_change: null }).qb === 0;
  })());
  chk('the magnitude is the coefficient-weighted sum of the features, term by term', (() => {
    const M = RS.magnitude({ new_hc: true, returning_production_pct: 0.1, qb_change: true, incoming_production_pct: 0.9 }, { coach: 0.3, prod: 0.5, qb: 0.2, port: 0.1 });
    return near(M.m, 0.3 + 0.5 * 0.8 + 0.2 + 0.1 * 0.8) && near(M.terms.prod, 0.4) && RS.magnitude({}, null) === null;
  })());
  chk('the weight is the standard weight times exp(−m), never above it', near(RS.magnitudeWeight(0.8, 0.3), 0.8 * Math.exp(-0.3)) && RS.magnitudeWeight(0.8, -1) === 0.8);

  /* a board with 24 programmes that have played, so the track centres are measurable */
  const st = E.newState();
  E.ingest.seasonBreak(st);
  const T = []; for (let i = 0; i < 24; i++) T.push('Team ' + String.fromCharCode(65 + i));
  for (let w = 0; w < 4; w++) for (let i = 0; i < 12; i++)
    E.ingest.absorbGame(st, { home: T[(i + w) % 24], away: T[(i + 12 + 3 * w) % 24], home_fbs: true, away_fbs: true, home_points: 17 + ((i * 7 + w) % 21), away_points: 20 });
  const tc = E.strength.trackCentres(st);
  chk('the track centres are measured over this season\'s programmes that have played (24 here), and the offset is the difference of the two means',
    tc.available === true && tc.teams === 24 && near(tc.offset, tc.carried - tc.this_season, 1e-12), tc);
  const small = E.newState(); E.ingest.seasonBreak(small);
  E.ingest.absorbGame(small, { home: 'Iowa State', away: 'Kansas', home_fbs: true, away_fbs: true, home_points: 17, away_points: 31 });
  chk('…and are UNAVAILABLE before 20 programmes have played', E.strength.trackCentres(small).available === false);

  const kick = new Date(Date.now() + 3 * 86400e3).toISOString();
  const req = (rh) => ({ season: 2026, week: 5, state: st, game: { home: T[0], away: T[1], home_fbs: true, away_fbs: true, neutral_site: false, kickoff: kick },
    teams: { home: { conference: 'Big 12', regime: rh || null }, away: { conference: 'Big 12' } } });
  const base = E.projectGame(req(null)), B0 = base.layers.strength.preseason_blend;
  const m = 0.4, mag = E.projectGame(req({ regime_change: false, magnitude: m, magnitude_terms: { coach: 0.25, prod: 0.15 } }));
  const B1 = mag.layers.strength.preseason_blend, S1 = mag.layers.strength.regime.home;
  chk('the magnitude path weights the long-run state w_standard·exp(−m), for a programme the binary flag did NOT fire on',
    near(B1.home_prior_weight, B0.home_prior_weight * Math.exp(-m), 1e-12) && S1.regime_change === false && S1.applied === true, [B1.home_prior_weight, B0.home_prior_weight, S1]);
  chk('…and moves the fair margin by exactly (w − w_std)·(long-run − this season − track offset): the cut weight lands on the CENTRED track',
    near(mag.model.fair_spread - base.model.fair_spread, (B1.home_prior_weight - B1.home_standard_prior_weight) * (B1.home_carried - B1.home_this_season - tc.offset), 1e-9)
      && S1.centring && S1.centring.applied === true, [mag.model.fair_spread - base.model.fair_spread, S1.centring]);
  chk('…and names it ROSTER TURNOVER (not REGIME CHANGE) in the data-quality warnings', (mag.data_quality.warnings || []).some((w) => /^ROSTER TURNOVER \(/.test(w))
    && !(mag.data_quality.warnings || []).some((w) => /^REGIME CHANGE \(/.test(w)));
  const zero = E.projectGame(req({ regime_change: false, magnitude: 0 }));
  chk('magnitude 0 on an unflagged programme is the standard curve EXACTLY, with no regime state at all (Georgia, Ohio State)',
    zero.model.fair_spread === base.model.fair_spread && zero.layers.strength.regime.home === null);
  const sh = E.projectGame(req({ regime_change: false, prior_shift: -2.5, shift_decay: 0.1 })), B2 = sh.layers.strength.preseason_blend;
  chk('the shift form moves the long-run rating by prior_shift·exp(−decay·g) at the STANDARD weight',
    near(sh.model.fair_spread - base.model.fair_spread, B0.home_prior_weight * -2.5 * Math.exp(-0.1 * B0.home_games_played), 1e-9) && near(B2.home_prior_weight, B0.home_prior_weight, 1e-12));
  chk('a v1 record (no magnitude) still prices on the v1 curve, byte-identical to before', (() => {
    const R = { regime_change: true, reason: 'x', min_games_for_research: 6 };
    const a = E.projectGame(req(R)), Ba = a.layers.strength.preseason_blend;
    return near(a.model.fair_spread - base.model.fair_spread, (Ba.home_prior_weight - Ba.home_standard_prior_weight) * (Ba.home_carried - Ba.home_this_season), 1e-9)
      && !a.layers.strength.regime.home.centring;
  })());

  /* the contract forwards a magnitude ONLY when it is priced (promoted) */
  const rec = (priced, flag, mm) => ({ regime_change: flag, reason: 'r', team: 'X', min_games_for_research: flag ? 6 : null,
    magnitude: { priced: priced, magnitude: mm, terms: { coach: mm }, version: 'cfb_regime_magnitude_v2' } });
  chk('an UNPRICED (candidate) magnitude never reaches the engine: a flagged team gets the v1 record, an unflagged one nothing',
    (() => { const a = CONTRACT.regimeFor({ a: rec(false, true, 0.3) }, 'a'), b = CONTRACT.regimeFor({ b: rec(false, false, 0.3) }, 'b');
      return a && a.regime_change === true && a.magnitude === undefined && b === null; })());
  chk('a PRICED magnitude is forwarded, flagged or not (a turned-over roster without a coach change)',
    (() => { const a = CONTRACT.regimeFor({ a: rec(true, false, 0.3) }, 'a'), z = CONTRACT.regimeFor({ z: rec(true, false, 0) }, 'z');
      return a && a.regime_change === false && a.magnitude === 0.3 && a.min_games_for_research === null && z === null; })());

  /* the artifact and the published record */
  const MAG = require(path.join(ROOT, 'football', 'cfb_p4', 'regime_magnitude.js'));
  chk('the v2 artifact names its family, its 2021+ fit windows and its holdout, and cites a report that exists',
    MAG.version === 'cfb_regime_magnitude_v2' && /^2021-/.test(MAG.fitted_on) && MAG.evaluation_fitted_on === '2021-2023' && MAG.record.holdout === '2024-2025'
      && fs.existsSync(path.join(ROOT, MAG.report)), { v: MAG.version, f: MAG.fitted_on, e: MAG.evaluation_fitted_on });
  chk('status follows the verdict: PROMOTED only if the holdout says no worse than standard and v1', (MAG.status === 'PROMOTED') === (MAG.promoted === true) && MAG.promoted === MAG.verdict.promote);
  const REP = JSON.parse(fs.readFileSync(path.join(ROOT, MAG.report), 'utf8'));
  chk('the report\'s protocol: selection on 2021-2022 → 2023 only, holdout 2024-2025 never fitted, the market not an input, the disclosure present',
    REP.protocol.holdout_never_fitted === true && REP.protocol.market_is_an_input === false && /2023/.test(REP.protocol.selection)
      && REP.stage_a_selection.every((s) => s.fitted_on === '2021-2022' && s.validated_on === 2023) && /optimistic/.test(REP.protocol.disclosure));
  chk('the engine self-check held in the fit: the analytic counterfactual IS engine.js (both v2 forms)', REP.self_check.ok === true && REP.self_check.max_abs_difference < 1e-9);
  const RJ = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'coaching', 'regime.json'), 'utf8'));
  const all = Object.values(RJ.by_team);
  chk('every programme in the 2026 record carries its v2 inputs, features and magnitude, marked priced exactly when the artifact is promoted',
    all.length > 100 && all.every((t) => t.magnitude && t.magnitude.priced === (MAG.promoted === true) && t.magnitude.features && 'qb_change' in t && 'incoming_production_pct' in t));
  chk('the published magnitude is the artifact\'s formula over the published features', all.every((t) => {
    const M = t.magnitude; if (!M.terms) return false;
    const v = RS.MAGNITUDE_INPUTS.reduce((s, k) => s + (MAG.params[k] || 0) * M.features[k], 0);
    return MAG.family === 'shift' ? near(M.prior_shift, v, 1e-3) : near(M.magnitude, Math.max(0, v), 1e-3);
  }));
  const by = (k) => RJ.by_team[k];
  chk('Georgia and Ohio State: same coach, same QB, continuity above the median — zero magnitude', ['georgia', 'ohiostate'].every((k) => by(k) && by(k).qb_change === false
    && Object.values(by(k).magnitude.features).every((x) => x === 0)), ['georgia', 'ohiostate'].map((k) => by(k) && by(k).magnitude.features));
  chk('Iowa State and North Texas: new coach, new QB, bottom-decile returning production', ['iowastate', 'northtexas'].every((k) => by(k) && by(k).new_hc === true
    && by(k).qb_change === true && by(k).returning_production_pct <= 0.1));
  chk('the QB input names its basis (the starter observed vs last season\'s primary QB)', /vs last season.s primary QB/.test(by('iowastate').qb_basis || ''));
  chk('qbChangeOf: an observed starter decides; before one, the roster; nothing on file is unknown', BR.qbChangeOf({ prev_primary_qb_id: '1' }, { player_id: '2', status: 'PREVIOUS_GAME' }).qb_change === true
    && BR.qbChangeOf({ prev_primary_qb_id: '1' }, { player_id: '1', status: 'PREVIOUS_GAME' }).qb_change === false
    && BR.qbChangeOf({ prev_primary_qb_id: '1', returning_qb: true }, null).qb_change === false
    && BR.qbChangeOf({ prev_primary_qb_id: '1', returning_qb: false }, { status: 'UNKNOWN' }).qb_change === true
    && BR.qbChangeOf(null, null).qb_change === null);
}

console.log((fail ? 'FAILED ' : 'ALL GREEN ') + 'regime change — ' + pass + ' passed, ' + fail + ' failed');
if (fail) { failures.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
