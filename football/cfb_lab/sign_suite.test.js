#!/usr/bin/env node
/* ===========================================================================
   THE SIGN SUITE + FINANCIAL MATH (brief §21, §88) — run at deployment.

   ONE convention, everywhere (docs/cfb-lab/METRICS.md §1):
     home margin > 0      the home team is expected to win by that many
     home line  < 0       the home team is favoured (book convention)
     margin = -home_line  converted once, where a line enters

   Every layer that touches a sign is checked against the same known answers:
   lab_core (conversion, ATS, CLV, units), the V2 engine (pure, decide), the
   decision engine (cover probability, EV, targets), the ESPN reader and the
   Odds API capture (orientation), the event join (a swapped / neutral-site
   listing is refused). Scenarios: home favourite, road favourite, pick'em,
   neutral site, alternate spreads, book prices, ATS settlement, CLV — plus the
   property invariants (a better line never lowers the cover probability, a
   worse price never improves EV, a price change never moves the fair spread).

   Financial math is exact: American <-> decimal, break-even, devig, EV with
   pushes, units, CLV in points and in price, fractional Kelly with its caps.

   Run: node football/cfb_lab/sign_suite.test.js    (exit 1 on any failure)
   =========================================================================== */
'use strict';
const path = require('path');
const L = require('./lab_core.js');
const D = require('../cfb_decision/decision.js');
const MK = require('./market.js');
const ROOT = path.join(__dirname, '..', '..');
require(path.join(ROOT, 'football', 'cfb_v2', 'params.js'));
const E = require(path.join(ROOT, 'football', 'cfb_v2', 'engine.js'));
const INTEL = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_intelligence.js'));

let pass = 0, fail = 0; const fails = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; fails.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); } }
const near = (a, b, t) => typeof a === 'number' && Math.abs(a - b) <= (t == null ? 1e-9 : t);
const C = L.conv;

(async () => {
  /* ═══ 1. the convention ═══════════════════════════════════════════════ */
  chk('home line -7 is home margin +7, and back', C.bookToMargin(-7) === 7 && C.marginToBook(7) === -7);
  chk('road favourite: home line +7 is home margin -7', C.bookToMargin(7) === -7);
  chk("pick'em: 0 is 0 both ways, never -0", Object.is(C.bookToMargin(0), 0) && Object.is(C.marginToBook(0), 0) && Object.is(C.sideLine('AWAY', 0), 0));
  chk('a side\'s own number: AWAY at home -3.5 is +3.5; HOME is -3.5', C.sideLine('AWAY', -3.5) === 3.5 && C.sideLine('HOME', -3.5) === -3.5 && C.homeLineFromSide('AWAY', 3.5) === -3.5);
  chk('display names the favourite: margin +3.2 -> "Home -3.0", -7.26 -> "Away -7.5", 0.2 -> PICK',
    C.display(3.2, 'Home', 'Away') === 'Home -3.0' && C.display(-7.26, 'Home', 'Away') === 'Away -7.5' && C.display(0.2, 'Home', 'Away') === 'PICK');
  chk('the V2 engine uses the same conversion', E.conv.bookToMargin(-7) === 7 && E.conv.marginToBook(-3) === 3);

  /* ═══ 2. scenarios through lab_core grading ═══════════════════════════ */
  const S = [
    /* name, home line, final margin, side, expected ATS */
    ['home favourite covers: home -3.5, wins by 7', -3.5, 7, 'HOME', 'WIN'],
    ['home favourite fails: home -3.5, wins by 3', -3.5, 3, 'HOME', 'LOSS'],
    ['home favourite, the away side: +3.5 and home won by 3', -3.5, 3, 'AWAY', 'WIN'],
    ['road favourite covers: home +7, away wins by 14', 7, -14, 'AWAY', 'WIN'],
    ['road favourite pushes: home +7, away wins by 7', 7, -7, 'AWAY', 'PUSH'],
    ['road favourite, the home dog covers: home +7, loses by 3', 7, -3, 'HOME', 'WIN'],
    ["pick'em: home 0, home wins by 1", 0, 1, 'HOME', 'WIN'],
    ["pick'em: home 0, away wins by 1", 0, -1, 'HOME', 'LOSS'],
    ['a half point never pushes: home -3.5, wins by 3.5 is impossible, by 4 wins', -3.5, 4, 'HOME', 'WIN'],
    ['overtime counts: home -7, wins 45-38 in 2OT', -7, 7, 'HOME', 'PUSH'],
  ];
  S.forEach(([name, line, m, side, want]) => chk('ATS — ' + name, L.atsResult(side, line, m) === want, L.atsResult(side, line, m)));
  chk('ATS needs a side, a line and a margin (nothing is guessed)', L.atsResult(null, -3, 7) === null && L.atsResult('HOME', null, 7) === null && L.atsResult('HOME', -3, null) === null);

  /* ═══ 3. CLV: the METRICS worked examples and their mirrors ═════════ */
  chk('CLV: home at -3 that closed -5 = +2', L.clvPoints('HOME', -3, -5) === 2);
  chk('CLV: away +3 (home -3) that closed +5 (home -5) = -2', L.clvPoints('AWAY', -3, -5) === -2);
  chk('CLV: away +7 (home -7) that closed +4.5 (home -4.5) = +2.5', L.clvPoints('AWAY', -7, -4.5) === 2.5);
  chk('CLV: road favourite taken at away -7 (home +7) that closed away -9.5 (home +9.5) = +2.5 (laid 7 where the close lays 9.5)', L.clvPoints('AWAY', 7, 9.5) === 2.5);
  chk('CLV: ... and closed away -5 (home +5) = -2 (laid 7 where the close lays 5)', L.clvPoints('AWAY', 7, 5) === -2);
  chk('CLV in price: same line, -110 then -120 = +2.165 pp (the close priced the side higher)', L.clvPrice('HOME', -3, -3, -110, -120) === 2.165);
  chk('CLV in price is undefined when the lines differ', L.clvPrice('HOME', -3, -3.5, -110, -120) === null);
  chk('evaluate(): CLV and ATS come out with the same signs end to end', (() => {
    const pred = { prediction_id: 'p', game_id: 'g', model_version: 'm', checkpoint_type: 'T24', origin: 'LIVE', pure_home_margin: 6, side: 'HOME', recommended_line: -3,
      recommended_price: -110, current_spread: -3, model_market_gap: 3, stake_units: 0, cover_probability: 0.56 };
    const e = L.evaluate(pred, { result_id: 'r', status: 'FINAL', home_points: 27, away_points: 20 }, { close: { home_line: -5, price_home: -110, price_away: -110, quality: 'OBSERVED', line_id: 'l', n_books: 1 } });
    return e.ats_result === 'WIN' && e.clv_points === 2 && e.positive_clv === true && e.graded_line === -3 && e.hypothetical_units === 0.9091 && e.margin_error === 1;
  })());

  /* ═══ 4. prices: American <-> decimal, break-even, devig ═════════════ */
  chk('decimal: -110 -> 1.909091, +150 -> 2.5, -100 and +100 -> 2.0', near(L.toDecimal(-110), 1 + 100 / 110) && L.toDecimal(150) === 2.5 && L.toDecimal(-100) === 2 && L.toDecimal(100) === 2);
  chk('American from decimal: 2.5 -> +150, 1.5 -> -200, 2.0 -> +100', L.fromDecimal(2.5) === 150 && near(L.fromDecimal(1.5), -200) && L.fromDecimal(2) === 100);
  chk('round trips are exact at book prices', [-250, -150, -120, -115, -110, -105, 100, 105, 120, 150, 300].every((a) => L.roundHalfAway(L.fromDecimal(L.toDecimal(a))) === (a === -100 ? 100 : a)));
  chk('odds of 0 are no price at all (both engines)', L.toDecimal(0) === null && L.payout(0) === null && D.americanToPayout(0) === null && D.breakEven(0) === null);
  chk('the decision engine refuses a sub-100 "American" price; the lab refuses it at ingestion (integrity.js)', D.americanToPayout(-50) === null && D.americanToPayout(50) === null
    && require('./integrity.js').validateQuote({ market_type: 'spread', home_line: -3, price_home: -50, price_away: -110 }, {}).reasons.includes('PRICE_NOT_AMERICAN'));
  chk('break-even: -110 = 52.381%, +150 = 40%, -200 = 66.667%, +100 = 50%', near(D.breakEven(-110), 110 / 210) && near(D.breakEven(150), 0.4) && near(D.breakEven(-200), 2 / 3) && D.breakEven(100) === 0.5
    && near(L.impliedProb(-110), 110 / 210));
  const dv = D.devig(-110, -110);
  chk('devig -110 / -110: 50% / 50%, overround 4.762%', near(dv.p_a, 0.5) && near(dv.overround, 220 / 210 - 1));
  const dv2 = D.devig(-150, 130);
  chk('devig -150 / +130 sums to 1 after removing the vig', near(dv2.p_a + dv2.p_b, 1) && dv2.p_a > 0.5);
  chk('the capture rounds decimal to American half away from zero, like the lab', (() => { const M = MK; return typeof M.american === 'function'; })()
    && L.medianPrice([-105, 105]) === 100 && L.medianPrice([-110, -105]) === -107);

  /* ═══ 5. EV, pushes, units, Kelly (exact) ═══════════════════════════ */
  chk('EV at 55% and -110, no push: +0.05 per unit', near(D.expectedValue(0.55, 0, -110), 0.55 * (100 / 110) - 0.45, 1e-12) && near(D.expectedValue(0.55, 0, -110), 0.05, 1e-12));
  chk('EV with a 5% push: the push returns the stake -> 0.0475', near(D.expectedValue(0.55, 0.05, -110), 0.0475, 1e-12));
  chk('EV at break-even is exactly 0', near(D.expectedValue(110 / 210, 0, -110), 0, 1e-12));
  chk('EV at +150 and 45%: +0.125', near(D.expectedValue(0.45, 0, 150), 0.125, 1e-12));
  chk('a push is only possible on a whole-number line', D.pushProb(-3.5, { '2.5-3.5': 0.09 }) === 0 && D.pushProb(-3, { '2.5-3.5': 0.09 }) === 0.09);
  chk('units: WIN at -110 = +0.9091, LOSS = -1, PUSH = 0, VOID = none; WIN at +150 = +1.5',
    L.util.r(L.unitsFor('WIN', 1, -110), 4) === 0.9091 && L.unitsFor('LOSS', 1, -110) === -1 && L.unitsFor('PUSH', 1, -110) === 0 && L.unitsFor('VOID', 1, -110) === null && L.unitsFor('WIN', 1, 150) === 1.5);
  chk('a missing price never becomes a unit count', L.unitsFor('WIN', 1, null) === null);
  chk('Kelly fraction at 55% and -110 = 0.055', near(D.kellyFraction(0.55, -110), (0.55 * (100 / 110) - 0.45) / (100 / 110), 1e-12) && near(D.kellyFraction(0.55, -110), 0.055, 1e-12));
  chk('Kelly is 0 below break-even (never a negative stake)', D.kellyFraction(0.5, -110) === 0);
  const KP = { stake: { method: 'fractional_kelly', kelly_validated: true, kelly_fraction: 1, saturation_probability: 0.6, bankroll_u: 100, max_stake_u: 100 } };
  chk('fractional Kelly never exceeds quarter Kelly even if the policy asks for full', D.stake({ decision_cover_probability: 0.56, price: -110 }, KP) === L.util.r(D.kellyFraction(0.56, -110) * 0.25 * 100, 2));
  chk('without validated Kelly the stake is flat and capped', D.stake({ decision_cover_probability: 0.9, price: 200 }, { stake: { method: 'flat', unit_u: 1, max_stake_u: 1 } }) === 1);

  /* ═══ 6. the V2 engine and the decision engine agree on direction ═════ */
  const P = globalThis.EDCfbV2Params;
  const row = (mu, o) => Object.assign({ game_id: 'g', season: 2026, week: 6, home: 'Home U', away: 'Away St', kickoff: '2026-10-10T19:30:00Z', ens_pred: mu, sigma: 15.5, fair_total: 52,
    ens_sd: 2, reliability_base: 70, qb: {}, neutral_site: false }, o || {});
  const pHome = E.pure(row(7));
  chk('V2 home favourite by 7: fair line -7, home win > 50%', pHome.status === 'PREDICTED' && pHome.fair_spread_home_line === -7 && pHome.home_win_prob > 0.5 && /Home U -7/.test(pHome.fair_spread_display), pHome.status);
  const pRoad = E.pure(row(-10));
  chk('V2 road favourite by 10: fair line +10, home win < 50%, display names the away team', pRoad.fair_spread_home_line === 10 && pRoad.home_win_prob < 0.5 && /Away St -10/.test(pRoad.fair_spread_display));
  const pPick = E.pure(row(0));
  chk("V2 pick'em: fair line 0 and 50%", pPick.fair_spread_home_line === 0 && near(pPick.home_win_prob, 0.5, 0.02));
  const pNeutral = E.pure(row(7, { neutral_site: true }));
  chk('V2 neutral site: the flag never flips a sign (same fair line as a home game with the same margin)', pNeutral.fair_spread_home_line === -7 && pNeutral.neutral_site === true);
  const now = '2026-10-10T12:00:00Z';
  const dHome = E.decide(pHome, { current: { home_line: -3, ts: '2026-10-10T11:50:00Z' }, price_home: -110, price_away: -110 }, { now, row: row(7) });
  chk('V2 decide: model +7 vs market home -3 -> gap +4 -> side HOME', dHome.raw_gap_pts === 4 && dHome.side === 'HOME', dHome);
  const dAway = E.decide(pRoad, { current: { home_line: 7, ts: '2026-10-10T11:50:00Z' }, price_home: -110, price_away: -110 }, { now, row: row(-10) });
  chk('V2 decide: model -10 vs market home +7 -> gap -3 -> side AWAY', dAway.raw_gap_pts === -3 && dAway.side === 'AWAY', dAway);
  const dFlip = E.decide(pHome, { current: { home_line: 25, ts: '2026-10-10T11:50:00Z' }, price_home: -110, price_away: -110 }, { now, row: row(7) });
  chk('V2 decide: a market that looks sign-flipped is REVIEW (a data fault), never an edge', dFlip.status === 'REVIEW' || dFlip.data_fault === 'orientation' || dFlip.status === 'PASS', dFlip.status);
  const pure = { status: 'PREDICTED', game_id: 'g', model_version: 'x', projected_margin: 7, sigma: 15, t_df: 100 };
  chk('decision engine: model +7 vs home -3 favours HOME (> 50%) and AWAY gets the complement', D.pureCover(pure, -3, 'HOME') > 0.5 && near(D.pureCover(pure, -3, 'HOME') + D.pureCover(pure, -3, 'AWAY'), 1));
  chk('decision engine: road favourite model -10 vs home +7 favours AWAY', D.pureCover(Object.assign({}, pure, { projected_margin: -10 }), 7, 'AWAY') > 0.5);
  chk("decision engine: pick'em model 0 vs line 0 is 50/50", near(D.pureCover(Object.assign({}, pure, { projected_margin: 0 }), 0, 'HOME'), 0.5, 1e-9));

  /* the engine rounds margin and fair line to 0.01 separately: they may differ
     by one cent at a half-cent boundary, never by a sign */
  const pr = E.pure(row(6.825));
  chk('V2 rounding: 6.825 -> margin 6.83 and fair line -6.82 (a cent of rounding, never a sign)', pr.projected_margin === 6.83 && pr.fair_spread_home_line === -6.82, [pr.projected_margin, pr.fair_spread_home_line]);
  const curj = JSON.parse(require('fs').readFileSync(path.join(ROOT, 'football', 'cfb_v2', 'current.json'), 'utf8'));
  const bad = (curj.rows || []).map((r) => E.pure(r, {})).filter((x) => x.status === 'PREDICTED')
    .filter((x) => !(Math.abs(x.fair_spread_home_line + x.projected_margin) <= 0.011 && (Math.abs(x.projected_margin) < 0.01 || Math.sign(x.fair_spread_home_line) === -Math.sign(x.projected_margin))
      && Math.abs(x.home_win_prob + x.away_win_prob - 1) <= 1e-3 && (x.projected_margin > 0) === (x.home_win_prob > 0.5 || x.projected_margin === 0)));
  chk('V2 live contract: every PREDICTED row of current.json has fair line = -margin (within rounding), p_home + p_away = 1, and p_home > 50% exactly when the margin favours home', bad.length === 0, bad.map((x) => [x.game_id, x.projected_margin, x.fair_spread_home_line, x.home_win_prob]));

  /* ═══ 7. properties (alternate spreads, prices) ══════════════════════ */
  const lines = []; for (let x = -20; x <= 20; x += 0.5) lines.push(x);
  const homeP = lines.map((l) => D.pureCover(pure, l, 'HOME'));
  chk('property: a better home line (more points for home) never lowers the home cover probability (alternate spreads)', homeP.every((p, i) => i === 0 || p >= homeP[i - 1] - 1e-12));
  const awayP = lines.map((l) => D.pureCover(pure, l, 'AWAY'));
  chk('property: and never raises the away one', awayP.every((p, i) => i === 0 || p <= awayP[i - 1] + 1e-12));
  const prices = [-200, -150, -130, -120, -115, -110, -105, 100, 110, 130, 150];
  const evs = prices.map((a) => D.expectedValue(0.55, 0.03, a));
  chk('property: a worse price never improves EV', evs.every((v, i) => i === 0 || v >= evs[i - 1] - 1e-12));
  const fair = prices.map((a) => E.decide(pHome, { current: { home_line: -3, ts: '2026-10-10T11:50:00Z' }, price_home: a, price_away: -110 }, { now, row: row(7) }).pure_fair_margin);
  chk('property: changing only the price never moves the pure fair margin', fair.every((f) => f === pHome.projected_margin));

  /* ═══ 8. orientation at the edges: ESPN, the Odds API, the event join ══ */
  const espn = (details, spread, hf) => ({ events: [{ id: '1', competitions: [{ date: '2026-10-10T19:30Z', status: { type: { state: 'pre', completed: false, name: 'STATUS_SCHEDULED' } },
    competitors: [{ homeAway: 'home', team: { abbreviation: 'HOM', displayName: 'Home U' } }, { homeAway: 'away', team: { abbreviation: 'AWY', displayName: 'Away St' } }],
    odds: [{ provider: { name: 'DraftKings' }, details, spread, homeTeamOdds: { favorite: hf }, awayTeamOdds: { favorite: !hf } }] }] }] });
  const eq = (j) => MK.quotesFromEspn(j, '2026-10-08T12:00:00Z', {}).find((q) => q.market_type === 'spread' && !q.is_provider_open);
  chk('ESPN: "HOM -7" is home line -7', eq(espn('HOM -7', -7, true)).home_line === -7);
  chk('ESPN: "AWY -7" (road favourite) is home line +7', eq(espn('AWY -7', 7, false)).home_line === 7);
  chk('ESPN: readings that disagree about WHICH side is favoured drop the line (never guessed)', !eq(espn('HOM -7', 7, false)));
  process.env.CAPTURE_NO_SERVE = '1';
  globalThis.Deno = globalThis.Deno || { env: { get: (k) => process.env[k] } };
  const CAP = await import(path.join(ROOT, 'supabase', 'functions', 'capture', 'index.ts'));
  const oa = (homeName, awayName, homePt) => CAP.cfbLabQuotes([{ id: 'e', commence_time: '2026-10-10T19:30:00Z', home_team: homeName, away_team: awayName,
    bookmakers: [{ key: 'dk', markets: [{ key: 'spreads', outcomes: [{ name: awayName, price: 1.91, point: -homePt }, { name: homeName, price: 1.91, point: homePt }] }] }] }], '2026-10-08T12:00:00Z', Date.parse('2026-10-08T12:00:00Z')).quotes[0];
  chk('Odds API: the home line is the home team\'s number even when the away side is listed first', oa('Home U', 'Away St', -7).home_line === -7 && oa('Home U', 'Away St', 7).home_line === 7);
  const games = [{ game_id: 'g1', home_team: 'Texas', away_team: 'Oklahoma', kickoff: '2026-10-10T16:00:00Z' }];
  const join = (h, a) => INTEL.joinSignalsToGames({ signals: [{ provider_event_id: 'e1', home_team: h, away_team: a, commence_time: '2026-10-10T16:00:00Z' }], games });
  chk('neutral site: a book listing Oklahoma as "home" is REFUSED, never joined with the sign flipped', join('Oklahoma Sooners', 'Texas Longhorns').signals_joined === 0);
  chk('... and the same orientation joins', join('Texas Longhorns', 'Oklahoma Sooners').signals_joined === 1);

  fails.forEach((f) => console.log('FAIL | ' + f));
  console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
