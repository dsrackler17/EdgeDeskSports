#!/usr/bin/env node
/* ===========================================================================
   Tests for the INFORMATION LAYER — "how good is my information?", separated
   from "what does the model price?".

   The bug these exist to keep closed: `uncertainty.confidence` was handed
   PRICED measurements for five of its twelve inputs. A priced measurement is
   missing whenever the LAYER is unpriced, which is a statement about the
   model's coefficients rather than about what EdgeDesk retrieved — so the
   quarterback term, the heaviest in the table, scored zero on every game in
   the universe while the starter was resolved for 96% of the field.

   What must hold, in the order it would break:

     1  NOTHING HERE MOVES A PRICE. Not the spread, not the total, not sigma,
        not a contribution. This is the whole licence for the change and it is
        tested first.
     2  the quarterback term DISCRIMINATES — a resolved dominant starter and
        an unknown one must not score alike, which is what a constant zero did
     3  its confidence is the MEASURED persistence rate, and with no
        calibration supplied it declares itself unmeasured rather than
        substituting a constant
     4  availability is scoped to what the engine can actually price, and says
        so, and never claims to know about positions it cannot see
     5  the rating blend never LOWERS a well-observed rating, and never credits
        a shared FCS floor as if it were information about one programme
     6  a missing input is still missing — none of this invents a measurement

   Run: node football/cfb_p4/information.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
global.window = global.window || global;
require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const P = global.EDCfbP4Params;
const E = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
const I = E.uncertainty.information;

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.stack) || e).slice(0, 300) }; } }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function done() {
  failures.forEach(f => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 460) : '')));
  console.log('\ninformation layer: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
const near = (a, b) => Math.abs(a - b) < 1e-9;

/* the calibration this layer reads */
const CAL = JSON.parse(fs.readFileSync(path.join(ROOT, 'football', 'starters', 'persistence.json'), 'utf8'));
const bandRate = id => (CAL.by_band.filter(b => b.id === id)[0] || {}).rate;
const dominant = { band: 'dominant', rate: bandRate('dominant'), pairs: 7511 };
const fragment = { band: 'fragment', rate: bandRate('fragment'), pairs: 989 };

/* =============================== 1. NOTHING HERE MOVES A PRICE */
{
  const base = () => ({
    season: 2026, week: 3, state: E.newState(),
    game: { home: 'Alabama', away: 'Auburn', home_fbs: true, away_fbs: true },
    teams: { home: { conference: 'SEC' }, away: { conference: 'SEC' } },
    venue: {}, market: {}, timestamps: {}
  });
  const withQb = base();
  withQb.teams.home.qb_context = { player: 'A Passer', player_id: '1', status: 'PREVIOUS_GAME',
    identity_corroborated: true, last_game_share: 0.92, persistence: dominant,
    dropbacks: 400, starts: 14 };
  withQb.teams.away.qb_context = { player: 'B Passer', player_id: '2', status: 'PREVIOUS_GAME',
    identity_corroborated: true, last_game_share: 0.90, persistence: dominant,
    dropbacks: 380, starts: 12 };

  const a = E.projectGame(base()), b = E.projectGame(withQb);
  chk('both project', a.status === 'PREDICTED' && b.status === 'PREDICTED', [a.status, b.status]);

  const priced = p => JSON.stringify({
    spread: p.model.fair_spread, total: p.model.fair_total, wp: p.model.home_win_prob,
    sigma: p.model.sigma_margin, p10: p.model.p10_margin, p90: p.model.p90_margin,
    median: p.model.median_margin, hml: p.model.fair_home_ml, aml: p.model.fair_away_ml,
    vol: p.scores.volatility, inj: p.scores.injury_uncertainty,
    contrib: (p.contributions || []).map(c => c.key + '=' + c.points)
  });
  chk('supplying the starter context moves NO priced number', priced(a) === priced(b),
    { without: priced(a).slice(0, 220), with: priced(b).slice(0, 220) });
  chk('and it DOES move the information confidence — otherwise it is doing nothing',
    b.scores.confidence > a.scores.confidence, { without: a.scores.confidence, with: b.scores.confidence });
  chk('the priced confidence is unmoved by it, because nothing priced changed',
    near(a.scores.confidence_priced, b.scores.confidence_priced),
    { without: a.scores.confidence_priced, with: b.scores.confidence_priced });
  chk('priced confidence never exceeds information confidence',
    b.scores.confidence_priced <= b.scores.confidence + 1e-9,
    { priced: b.scores.confidence_priced, info: b.scores.confidence });
  /* the starter must not have leaked into the PRICED qb layer by any route */
  chk('the priced QB layer is still dark — qb_context is not qb',
    b.layers.qb.home.value.available === false, b.layers.qb.home.value);
  chk('and the QB contribution is still zero points',
    ((b.contributions || []).filter(c => c.key === 'qb')[0] || {}).points === 0,
    (b.contributions || []).filter(c => c.key === 'qb'));
}

/* =============================== 2 + 3. the quarterback term */
{
  const q = (o) => I.quarterback(o, 'home');
  chk('no context at all is missing, not zero-with-confidence',
    q(null).available === false && /no starter context/.test(q(null).reason), q(null));
  chk('an UNKNOWN status is a MEASUREMENT of zero, not a gap',
    q({ status: 'UNKNOWN' }).available === true && q({ status: 'UNKNOWN' }).value === 0,
    q({ status: 'UNKNOWN' }));
  chk('and it says it was declared unknown rather than assumed average',
    /declared unknown/.test(q({ status: 'UNKNOWN' }).basis), q({ status: 'UNKNOWN' }).basis);

  const strong = q({ player: 'X', player_id: '1', status: 'PREVIOUS_GAME', identity_corroborated: true,
    last_game_share: 0.92, persistence: dominant });
  const weak = q({ player: 'Y', player_id: '2', status: 'PREVIOUS_GAME', identity_corroborated: true,
    last_game_share: 0.2, persistence: fragment });
  chk('a dominant starter scores the MEASURED dominant rate', near(strong.confidence, dominant.rate),
    { got: strong.confidence, measured: dominant.rate });
  chk('an opener who handed it over scores the MEASURED fragment rate', near(weak.confidence, fragment.rate),
    { got: weak.confidence, measured: fragment.rate });
  /* THE WHOLE POINT: the term has to tell these two apart. The old priced
     term scored both of them, and every other game on the board, at zero. */
  chk('the term DISCRIMINATES between them by a wide margin',
    strong.confidence - weak.confidence > 0.5, { strong: strong.confidence, weak: weak.confidence });
  chk('the basis quotes the rate and the sample rather than asserting a score',
    /\d+% of the time/.test(strong.basis) && /pairs/.test(strong.basis), strong.basis);

  const uncal = q({ player: 'Z', player_id: '3', status: 'PREVIOUS_GAME', identity_corroborated: true,
    last_game_share: 0.9, persistence: null });
  chk('NO CALIBRATION means unmeasured, never a substituted constant',
    uncal.available === false && /not measured/.test(uncal.reason), uncal);

  const uncorr = q({ player: 'X', player_id: '1', status: 'PREVIOUS_GAME', identity_corroborated: false,
    last_game_share: 0.92, persistence: dominant });
  chk('an uncorroborated identity is discounted', uncorr.confidence < strong.confidence, {
    corroborated: strong.confidence, not: uncorr.confidence });
  const conflict = q({ player: 'X', player_id: '1', status: 'PREVIOUS_GAME', identity_corroborated: true,
    field_state: 'CONFLICTING', last_game_share: 0.92, persistence: dominant });
  chk('a conflicting record is discounted', conflict.confidence < strong.confidence);

  /* the combiner: an unknown starter opposite a resolved one must not be
     papered over by the resolved side */
  const both = I.weaker(strong, weak, 'none');
  chk('the weaker side is the one that counts', near(both.confidence, weak.confidence));
}

/* =============================== 4. availability is scoped, and says so */
{
  const noRead = { injuries: { points: { available: false, reason: 'none' } } };
  const graded = { injuries: { points: { available: true, confidence: 0.6, value: 0 } } };
  const qbInfo = { available: true, value: 0.87, confidence: 0.87, n: 7511 };

  const scoped = I.availability(noRead, noRead, qbInfo);
  chk('with no injury read, availability falls back to the observed quarterback',
    scoped.available === true && near(scoped.confidence, 0.87), scoped);
  chk('and it names the scope rather than implying a full report',
    /only position this engine/.test(scoped.basis) && /every other position/.test(scoped.basis), scoped.basis);
  chk('and it points at where the unseen absences ARE priced — volatility',
    /volatility/.test(scoped.basis), scoped.basis);
  /* the claim must be true of the shipped parameters, not just of the prose */
  chk('the scope claim matches the trained parameters: QB is the only priced position',
    Object.keys(P.injury.position_weight).length === 1 && P.injury.position_weight.QB > 0,
    P.injury.position_weight);

  /* TWO SOURCES ABOUT ONE QUESTION leave you at least as well informed as the
     better of them. This branch used to short-circuit on the graded read, so
     a report arriving at its layer's flat 0.6 made the availability term FALL
     below the measured participation observation — a source starting to
     answer made the score worse. */
  const real = I.availability(graded, noRead, qbInfo);
  chk('a graded read never LOWERS availability below the observation it joins',
    real.confidence >= scoped.confidence - 1e-9, { joined: real.confidence, observation: scoped.confidence });
  chk('and the source names whichever of the two is actually stronger',
    real.confidence > graded.injuries.points.confidence
      ? /play attribution/.test(real.source) : /graded availability read/.test(real.source), real);
  const weakQb = { available: true, value: 0.12, confidence: 0.12, n: 989 };
  const gradedWins = I.availability(graded, noRead, weakQb);
  chk('and where the report IS the stronger source, it is the one named',
    /graded availability read/.test(gradedWins.source)
      && Math.abs(gradedWins.confidence - 0.6) < 1e-9, gradedWins);
  const nothing = I.availability(noRead, noRead, { available: false, reason: 'x' });
  chk('no read and no quarterback observation is MISSING, never a clean bill of health',
    nothing.available === false && /no availability information of any kind/.test(nothing.reason), nothing);
}

/* =============================== 5. the rating blend */
{
  const gap = { available: true, value: 7, confidence: 0.33, n: 2, source: 'opponent-adjusted rating' };
  const fbs = pw => ({ is_fbs: true, blended: { prior_weight: pw } });
  const early = I.ratingGap(gap, fbs(0.9), fbs(0.9));
  chk('a thin in-season sample is lifted by the trained prior', early.confidence > gap.confidence,
    { before: gap.confidence, after: early.confidence });
  chk('and the basis says how the blend splits', /trained prior/.test(early.basis), early.basis);

  const strongGap = { available: true, value: 7, confidence: 1, n: 12, source: 'x' };
  const late = I.ratingGap(strongGap, fbs(0.1), fbs(0.1));
  chk('a PRIOR NEVER LOWERS a well-observed rating', late.confidence >= strongGap.confidence - 1e-9,
    { before: strongGap.confidence, after: late.confidence });

  /* the FCS floor is one number every unrated programme shares; crediting it
     as knowledge of THIS opponent scored an FBS-vs-FCS game above a
     conference game on the first attempt at this function */
  const fcs = I.ratingGap(gap, fbs(0.9), { is_fbs: false, blended: { prior_weight: 1 } });
  chk('a shared FCS floor earns NO prior credit', near(fcs.confidence, gap.confidence),
    { got: fcs.confidence, expected: gap.confidence });

  const missing = { available: false, reason: 'no opponent-adjusted rating' };
  chk('an unrated programme stays exactly as missing as it was',
    I.ratingGap(missing, fbs(1), fbs(1)) === missing);
}

/* =============================== 6. nothing here invents a measurement */
{
  chk('a roster nobody supplied is missing', I.roster(null, 'home').available === false);
  chk('an empty roster profile is missing',
    I.roster({ by_group: {} }, 'home').available === false, I.roster({ by_group: {} }, 'home'));
  const half = I.roster({ by_group: { QB: {
    talent: { available: true, confidence: 0.5 },
    experience: { available: true, confidence: 1 },
    continuity: { available: false }, returning_production: { available: false },
    portal_in: { available: false }, portal_out: { available: false } } },
    overall: { available: false } }, 'home');
  chk('a half-filled contract scores below a full one and above nothing',
    half.available === true && half.value > 0 && half.value < 1, half);
  chk('and the denominator is the layer\'s own contract, not a chosen weight',
    half.n === 7, half.n);
}

done();
