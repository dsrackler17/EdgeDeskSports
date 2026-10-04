#!/usr/bin/env node
/* ============================================================================
   THE DISAGREEMENT EXPLAINER (audit 2026-09-30 follow-up #3).

   lib/edgedesk_explainer.js splits a model-market gap into measured terms of
   EdgeDesk's own projection, discounted by how much of each the closing
   market has historically taken out (football/validation/
   disagreement_explainer.json, tools/football/explainer_fit.js). This holds:
     1  the terms are exact pieces of the projection (engine.js), none from the market
     2  explained + unexplained = the gap, always; a term the fit could not
        measure is shown and never discounted
     3  the fit's provenance: 2021-2023, holdout 2024-2025, shipped 2021-2025,
        significance as stated, the market never an input
     4  the terminal and the slate carry it through the same functions

     node tools/football/explainer.test.js
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

const X = require(path.join(ROOT, 'lib', 'edgedesk_explainer.js'));
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
const FIT = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'validation', 'disagreement_explainer.json'), 'utf8'));

/* ======================================================================== */
section('1. the terms are exact pieces of the projection');
{
  const st = E.newState();
  E.ingest.seasonBreak(st);
  const T = []; for (let i = 0; i < 24; i++) T.push('Team ' + String.fromCharCode(65 + i));
  for (let w = 0; w < 4; w++) for (let i = 0; i < 12; i++)
    E.ingest.absorbGame(st, { home: T[(i + w) % 24], away: T[(i + 12 + 3 * w) % 24], home_fbs: true, away_fbs: true, home_points: 17 + ((i * 7 + w) % 21), away_points: 20 });
  const p = E.projectGame({ season: 2026, week: 5, state: st, game: { home: T[0], away: T[1], home_fbs: true, away_fbs: true, neutral_site: false },
    teams: { home: { conference: 'Big 12', regime: { regime_change: true, reason: 'x', min_games_for_research: 6 } }, away: { conference: 'Big 12' } } });
  const B = p.layers.strength.preseason_blend, tc = p.layers.strength.track_centres;
  const sides = { home: { features: { coach: 1, prod: 0.8, qb: 1, port: 0.4 }, qb_change: true }, away: { features: { coach: 0, prod: 0, qb: 0, port: 0 }, qb_change: false } };
  const t = X.termsFromProjection(p, sides);
  const share = (s) => B[s + '_prior_weight'] * (B[s + '_carried'] - B[s + '_this_season'] - tc.offset);
  chk('the projection publishes the track centres it was blended against', tc && tc.available === true && tc.teams === 24);
  chk('prior = w·(long-run − this season − track offset), home minus away, from the projection itself', near(t.prior, share('home') - share('away'), 1e-12), [t.prior, share('home') - share('away')]);
  chk('turnover = each side\'s turnover index × its prior share (the index: the mean of the four v2 features)', near(t.turnover, 0.8 * share('home') - 0 * share('away'), 1e-12) && near(X.turnoverIndex(sides.home.features), 0.8));
  const c = (k) => (p.contributions.find((x) => x.key === k) || {}).points || 0;
  chk('rating, home field, conference and matchup are the engine\'s own contributions', near(t.rating, c('rating')) && near(t.home_field, c('hfa')) && near(t.conference, c('conference')) && near(t.matchup, c('matchup')));
  chk('qb_change is home minus away (0/1 each); an unknown change is 0', t.qb_change === 1 && X.termsFromProjection(p, { home: { qb_change: null }, away: { qb_change: true } }).qb_change === -1);
  chk('no market is read: the terms are identical whatever the market is (there is no market argument)', X.termsFromProjection.length === 2);
  chk('an unprojected game has no terms', X.termsFromProjection({ status: 'REFUSED' }, sides) === null);
}

/* ======================================================================== */
section('2. explained + unexplained = the gap');
{
  const fit = { version: 'v', fitted_on: '2021-2023', intercept: -0.5, coef: { rating: 0.1, prior: -0.4, turnover: 0.5, home_field: 0.4 }, significant: { prior: true },
    holdout: { r2: 0.03 } };
  const terms = { rating: -10, prior: -7, turnover: -4, home_field: 4, qb_change: 0, conference: 0, matchup: -2.4, other: 0 };
  const e = X.explain(terms, -9.2, 1.5, fit, { home: 'Tulsa', away: 'North Texas' });
  chk('the gap is fair − market, toward the side it favours', near(e.gap_points, -10.7, 1e-9) && e.toward === 'North Texas');
  chk('explained = intercept + Σ β·x over the FITTED terms', near(e.explained_points, -0.5 + 0.1 * -10 + -0.4 * -7 + 0.5 * -4 + 0.4 * 4, 0.011), e.explained_points);
  chk('explained + unexplained = the gap', near(e.explained_points + e.unexplained_points, e.gap_points, 0.011));
  const m = e.parts.find((x) => x.key === 'matchup');
  chk('a term the fit could not measure (matchup here) is SHOWN, with no discount, and stays in the unexplained part', m && m.unfitted === true && m.discount === null && m.explained_points === 0);
  chk('the parts are ordered by the size of what they explain', e.parts.every((x, i, a) => i === 0 || Math.abs(a[i - 1].explained_points) >= Math.abs(x.explained_points)));
  chk('without a market, or without a fit, it says so rather than guessing', X.explain(terms, -9, null, fit).available === false && X.explain(terms, -9, 1, null).available === false);
}

/* ======================================================================== */
section('3. the fit');
{
  const H = FIT.holdout, S = FIT.explainer, V = FIT.evaluation_fit;
  chk('fitted on 2021-2023, scored on 2024-2025, shipped on 2021-2025, the market never an input',
    V.fitted_on === '2021-2023' && FIT.rules.holdout.join('-') === '2024-2025' && S.fitted_on === '2021-2025' && FIT.market_is_an_input === false
      && !!S.holdout && S.holdout.games === H.games && S.holdout.r2 === H.r2);
  chk('the holdout is reported as it came out, however small (R², mean |gap| vs mean |unexplained|)', typeof H.r2 === 'number' && H.games > 1000 && H.mean_abs_unexplained <= H.mean_abs_gap + 1e-9, H);
  chk('matchup and other are unfitted (0 in every replayed game) and say why', S.unfitted.indexOf('matchup') >= 0 && S.unfitted.indexOf('other') >= 0 && /never discounted/.test(S.unfitted_why) && !('matchup' in S.coef));
  chk('a coefficient is marked significant exactly when |β / se| >= 1.96', Object.keys(S.coef).every((k) => S.significant[k] === (Math.abs(S.coef[k] / S.se[k]) >= 1.96)));
  chk('every term the library knows is either fitted or named unfitted', X.TERMS.every((k) => k in S.coef || S.unfitted.indexOf(k) >= 0));
}

/* ======================================================================== */
section('4. the slate and the terminal carry it through the same functions');
{
  const BC = fs.readFileSync(path.join(ROOT, 'football', 'fbs', 'build_coverage.js'), 'utf8');
  chk('the published slate\'s disagreement inputs carry EXPL.termsFromProjection over the regime record (features, qb_change)', /explainer_terms: EXPL\.termsFromProjection\(p, \{ home: turnover\(g\.home_team\), away: turnover\(g\.away_team\) \}\)/.test(BC)
    && /features: r\.magnitude \? r\.magnitude\.features : null, qb_change/.test(BC));
  const TB = fs.readFileSync(path.join(ROOT, 'football', 'cfb_terminal', 'build.js'), 'utf8');
  chk('the terminal explains against the consensus it already shows (−home line = home margin), with the shipped fit', /EXPL\.explain\(t, o\.edgedesk\.home_margin, -o\.market\.consensus_home_line, ctx\.explainerFit/.test(TB)
    && /football\/validation\/disagreement_explainer\.json', null\) \|\| \{\}\)\.explainer/.test(TB));
  const SL = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'fbs', 'slate.json'), 'utf8'));
  const withTerms = (SL.games || []).filter((g) => g.disagreement_inputs && g.disagreement_inputs.explainer_terms);
  const predicted = (SL.games || []).filter((g) => g.model_status === 'PREDICTED' && g.disagreement_inputs);
  chk('the committed slate: every predicted game carries the terms once the slate is rebuilt with this code (' + withTerms.length + '/' + predicted.length + ' now)',
    withTerms.length === 0 || withTerms.length === predicted.length, { with: withTerms.length, of: predicted.length });
}

console.log((fail ? 'FAILED ' : 'ALL GREEN ') + 'disagreement explainer — ' + pass + ' passed, ' + fail + ' failed');
if (fail) { failures.forEach((f) => console.log('  ✗ ' + f)); process.exit(1); }
