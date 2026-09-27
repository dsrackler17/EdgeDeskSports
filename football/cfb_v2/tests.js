#!/usr/bin/env node
/* EdgeDesk CFB V2 — engine tests. `node football/cfb_v2/tests.js` (exit 0 = green).
   Plain node, the same chk() style as football/cfb_p4/tests.js. */
'use strict';
var path = require('path');
global.window = global.window || global;
require(path.join(__dirname, 'params.js'));
var E = require(path.join(__dirname, 'engine.js'));
var P = global.window.EDCfbV2Params;

var fail = 0, n = 0;
function chk(name, cond) { n++; if (!cond) { fail++; console.log('FAIL ' + name); } else console.log('ok   ' + name); }
function near(a, b, tol) { return Math.abs(a - b) <= (tol == null ? 1e-9 : tol); }
function clone(o) { return JSON.parse(JSON.stringify(o)); }

var ROW = {
  game_id: 1, season: 2026, week: 5, home: 'Home U', away: 'Away St', neutral_site: false,
  prediction_ts: '2026-09-29T12:00:00Z', feature_ts: '2026-09-29T12:00:00Z', kickoff: '2026-10-03T19:30:00Z',
  ens_pred: 6.0, sigma: 14.0, ens_sd: 2.0, rating_sd_sum: 0.9, fair_total: 55.5, min_games: 4,
  early_season: false, qb_unsettled_any: 0, qb_missing_any: 0, fcs_game: false,
  qb: { home: { exp_rating: 0.15, backup_rating: -0.10, team_rating: 0.15 },
        away: { exp_rating: 0.05, backup_rating: -0.05, team_rating: 0.05 } },
  components: { A_adj_eff: 5.5, B_elo: 6.5, C_ridge: 6.1, D_gbm: 5.8, E_drive: 6.2 },
  drivers: [{ feature: 'match_pass_edge', points: 3.1 }, { feature: 'match_trench_edge', points: -1.2 }],
  uncertainty_drivers: ['model disagreement']
};
var NOW = '2026-10-01T15:00:00Z';
function mkt(homeLine, extra) {
  var m = { current: { home_line: homeLine, ts: '2026-10-01T14:30:00Z' }, price_home: -110, price_away: -110,
    open: { home_line: homeLine + 1 } };
  if (extra) Object.keys(extra).forEach(function (k) { m[k] = extra[k]; });
  return m;
}

/* ---------------------------------------------------------- params */
chk('params loaded with a model version', !!(P && P.model_version));
chk('params declare the pure/market separation', P.layers && P.layers.pure_never_reads_market === true);

/* --------------------------------------------------- sign boundary */
chk('book -7 is margin +7', E.conv.bookToMargin(-7) === 7);
chk('margin +3.5 is book -3.5', E.conv.marginToBook(3.5) === -3.5);
chk('display names the favourite', E.conv.display(6.2, 'HOME', 'AWAY') === 'HOME -6.0'
  && E.conv.display(-2.6, 'HOME', 'AWAY') === 'AWAY -2.5' && E.conv.display(0.1, 'H', 'A') === 'PICK');
chk('null line stays null', E.conv.bookToMargin(null) === null && E.conv.bookToMargin(NaN) === null);

/* ------------------------------------------------------------ pure */
var p = E.pure(ROW, {});
chk('pure projection predicts', p.status === 'PREDICTED' && p.layer === 'pure_model_projection');
chk('projected margin is the frozen ensemble with no overlays... except the no-report QB rate',
  Math.abs(p.projected_margin - ROW.ens_pred) < 3);
chk('fair home line is the negated margin', near(p.fair_spread_home_line, -p.projected_margin, 1e-9));
chk('home favourite -> home win prob > 0.5', p.home_win_prob > 0.5 && near(p.home_win_prob + p.away_win_prob, 1, 1e-9));
chk('intervals nest 50 < 80 < 95', (p.intervals.p50[1] - p.intervals.p50[0]) < (p.intervals.p80[1] - p.intervals.p80[0])
  && (p.intervals.p80[1] - p.intervals.p80[0]) < (p.intervals.p95[1] - p.intervals.p95[0]));
chk('pure object is frozen (immutable snapshot)', Object.isFrozen(p) && Object.isFrozen(p.intervals));
var threw = false; try { 'use strict'; p.projected_margin = 99; } catch (e) { threw = true; }
chk('writing into the frozen projection throws or is ignored', threw || p.projected_margin !== 99);
chk('pure never carries market fields', !('current_home_line' in p) && !('raw_gap_pts' in p) && !('expected_value_per_unit' in p));

var sym = E.pure(Object.assign(clone(ROW), { ens_pred: 0 }), { qb_status: { home: 'confirmed', away: 'confirmed' } });
chk('a pick-em with both QBs confirmed is ~50%', Math.abs(sym.home_win_prob - 0.5) < 0.02);
var neg = E.pure(Object.assign(clone(ROW), { ens_pred: -6 }), { qb_status: { home: 'confirmed', away: 'confirmed' } });
var pos = E.pure(Object.assign(clone(ROW), { ens_pred: 6 }), { qb_status: { home: 'confirmed', away: 'confirmed' } });
chk('mirror symmetry: P(home | -6) = P(away | +6)', near(neg.home_win_prob, pos.away_win_prob, 0.01));
var neutral = E.pure(Object.assign(clone(ROW), { neutral_site: true }), {});
chk('neutral-site flag rides along; engine adds no home field of its own', neutral.neutral_site === true
  && near(neutral.projected_margin, p.projected_margin, 1e-9));

/* ------------------------------------------------------------- QB */
var conf = E.pure(ROW, { qb_status: { home: 'confirmed', away: 'confirmed' } });
var out = E.pure(ROW, { qb_status: { home: 'out', away: 'confirmed' } });
var q = E.pure(ROW, { qb_status: { home: 'questionable', away: 'confirmed' } });
var unk = E.pure(ROW, { qb_status: { home: null, away: 'confirmed' } });
chk('confirmed starter: no QB variance beyond ~0', conf.overlays.qb_home.var_pts < 0.2);
if (P.qb.applied) chk('starter OUT moves the line toward the backup', out.projected_margin < conf.projected_margin - 0.5);
else chk('starter OUT without a validated coefficient moves nothing', near(out.projected_margin, conf.projected_margin, 1e-9));
chk('questionable widens the distribution more than confirmed', q.sigma > conf.sigma);
chk('OUT is certain: less variance than questionable', out.overlays.qb_home.var_pts < q.overlays.qb_home.var_pts);
chk('unknown status widens vs confirmed (never assumed active)', unk.sigma > conf.sigma);
chk('questionable caps confidence', q.football_prediction_confidence <= P.reliability.caps.qb_unsettled);
var noHist = E.pure(Object.assign(clone(ROW), { qb: { home: null, away: null } }), {});
chk('no QB history: no invented QB point value', noHist.overlays.qb_home.mean_pts === 0);

/* -------------------------------------------------------- injuries */
var ol3 = [{ unit: 'OL', usage_share: 0.2, status: 'OUT' }, { unit: 'OL', usage_share: 0.2, status: 'OUT' },
           { unit: 'OL', usage_share: 0.2, status: 'OUT' }, { unit: 'OL', usage_share: 0.2, status: 'OUT' },
           { unit: 'OL', usage_share: 0.2, status: 'OUT' }, { unit: 'OL', usage_share: 0.2, status: 'OUT' }];
var inj = E._internal.injuryOverlay(ol3, P);
chk('correlated OL losses are capped at the unit cap', inj.units.OL <= P.injury.unit_caps.OL + 1e-12);
var many = E._internal.injuryOverlay(ol3.concat([{ unit: 'SKILL', usage_share: 1, status: 'OUT' },
  { unit: 'FRONT7', usage_share: 1, status: 'OUT' }, { unit: 'SECONDARY', usage_share: 1, status: 'OUT' }]), P);
chk('team-wide injury value is capped', many.capped_total <= P.injury.team_cap + 1e-12);
chk('injuries never move the mean (no trained coefficient)', many.mean_pts === 0 && P.injury.points_applied === false);
chk('injuries widen the distribution', E.pure(ROW, { injuries: { home: ol3 } }).sigma > p.sigma);
chk('unknown injury status is a coin flip, not active',
  E._internal.injuryOverlay([{ unit: 'SKILL', usage_share: 0.4, status: '??' }], P).units.SKILL > 0.1);

/* --------------------------------------------------------- weather */
chk('dome: weather adds nothing', E._internal.weatherOverlay({ dome: true, wind_mph: 30 }, P).var_pts === 0);
chk('high wind widens only', E.pure(ROW, { weather: { wind_mph: 28 } }).sigma >= p.sigma
  && E.pure(ROW, { weather: { wind_mph: 28 } }).projected_margin === p.projected_margin);

/* ------------------------------------------------ market decision */
var d0 = E.decide(p, null, { now: NOW, row: ROW });
chk('missing odds -> PASS with reason', d0.status === 'PASS' && /no market/.test(d0.reasons.join(' ')));
var stale = E.decide(p, { current: { home_line: -3, ts: '2026-09-29T00:00:00Z' }, price_home: -110, price_away: -110 }, { now: NOW, row: ROW });
chk('stale odds -> PASS, not actionable', stale.status === 'PASS' && stale.stale === true);
var noTs = E.decide(p, { current: { home_line: -3 }, price_home: -110, price_away: -110 }, { now: NOW, row: ROW });
chk('odds with no timestamp are not actionable', noTs.status === 'PASS');
var d1 = E.decide(p, mkt(-3), { now: NOW, row: ROW });
chk('market sign: book -3 is market margin +3', d1.current_market_margin === 3);
chk('gap is model minus market in margin terms', near(d1.raw_gap_pts, p.projected_margin - 3, 1e-9));
chk('model above the market takes the HOME side', d1.side === 'HOME');
var d2 = E.decide(p, mkt(-10), { now: NOW, row: ROW });
chk('model below the market takes the AWAY side', d2.side === 'AWAY');
chk('cover probability in (0,1) and break-even at -110 is 0.5238',
  d1.cover_probability > 0 && d1.cover_probability < 1 && near(d1.break_even_probability, 0.5238, 1e-4));
var noPrice = E.decide(p, { current: { home_line: -3, ts: '2026-10-01T14:30:00Z' } }, { now: NOW, row: ROW });
chk('no price: EV is null, never assumed -110', noPrice.expected_value_per_unit === null && noPrice.status === 'PASS');
var flip = E.decide(Object.assign({}, p, { projected_margin: 24 }), mkt(24), { now: NOW, row: ROW });
chk('a sign-flipped market row is a data fault, never an edge', flip.status === 'REVIEW' && flip.data_fault === 'orientation');
var huge = E.decide(Object.assign({}, p, { projected_margin: 20 }), mkt(-5), { now: NOW, row: ROW });
chk('a disagreement beyond the review gap is REVIEW, not BET', huge.status === 'REVIEW' || huge.status === 'PASS');
var disp = E.decide(p, { books: [{ home_line: -1 }, { home_line: -3 }, { home_line: -5 }, { home_line: -7 }],
  ts: '2026-10-01T14:30:00Z', price_home: -110, price_away: -110 }, { now: NOW, row: ROW });
chk('dispersed books are a PASS', disp.status === 'PASS');
chk('decision never mutates the pure projection', p.projected_margin === E.pure(ROW, {}).projected_margin);
chk('BET is never emitted while the rule is not validated',
  P.market.bet_enabled || [d1, d2].every(function (d) { return d.status !== 'BET'; }));

/* ------------------------------------------- sign scenarios (audit) */
/* The same scenarios as research/v2/tests_signs.py, through the production
   decision path. Model margins are INTERNAL (+ = home wins by that many);
   lines are BOOK (home -7 = home laying 7). */
var SCEN = [
  /* name, open home line, current home line, model margin, neutral, side, gap, moved */
  ['home favourite', -7, -8.5, 10, false, 'HOME', 1.5, 'toward EdgeDesk'],
  ['road favourite', 7, 8.5, -10, false, 'AWAY', -1.5, 'toward EdgeDesk'],
  ['neutral-site favourite', -7, -8.5, 10, true, 'HOME', 1.5, 'toward EdgeDesk'],
  ['home favourite, model takes the dog', -7, -8, 3, false, 'AWAY', -5, 'away from EdgeDesk'],
  ['favourite flip', -2, 1.5, -3, false, 'AWAY', -1.5, 'toward EdgeDesk'],
  /* a small gap can be overruled by the learned home-cover intercept (home sides
     cover 48.6% historically), so the pick'em case uses an unambiguous gap */
  ["pick'em", 0, -1, 4, false, 'HOME', 3, 'toward EdgeDesk']
];
SCEN.forEach(function (s) {
  var pp = E.pure(Object.assign(clone(ROW), { ens_pred: s[3], neutral_site: s[4] }),
    { qb_status: { home: 'confirmed', away: 'confirmed' } });
  var d = E.decide(pp, { current: { home_line: s[2], ts: '2026-10-01T14:30:00Z' }, open: { home_line: s[1] },
    price_home: -110, price_away: -110 }, { now: NOW, row: ROW });
  chk('sign scenario ' + s[0] + ': market margin is the negated current line', d.current_market_margin === -s[2]);
  chk('sign scenario ' + s[0] + ': gap = model - market (' + s[6] + ')', near(d.raw_gap_pts, pp.projected_margin + s[2], 1e-9)
    && Math.sign(d.raw_gap_pts) === Math.sign(s[6]));
  chk('sign scenario ' + s[0] + ': side ' + s[5], d.side === s[5]);
  chk('sign scenario ' + s[0] + ': line move ' + s[7], d.market_moved === s[7]);
  chk('sign scenario ' + s[0] + ': expected CLV has the sign of the move toward the side',
    d.clv_opportunity_pts === null || Math.sign(d.clv_opportunity_pts) === (Math.abs(d.raw_gap_pts) < 1e-9 ? 0 : 1));
  chk('sign scenario ' + s[0] + ': EV > 0 only if cover probability beats break-even',
    (d.expected_value_per_unit > 0) === (d.cover_probability * (1 - d.push_probability) * (100 / 110)
      - (1 - d.cover_probability) * (1 - d.push_probability) > 0));
});
var mirror = E.decide(E.pure(Object.assign(clone(ROW), { ens_pred: -6 }), { qb_status: { home: 'confirmed', away: 'confirmed' } }),
  mkt(3), { now: NOW, row: ROW });
var direct = E.decide(E.pure(Object.assign(clone(ROW), { ens_pred: 6 }), { qb_status: { home: 'confirmed', away: 'confirmed' } }),
  mkt(-3), { now: NOW, row: ROW });
chk('mirror: swapping home/away flips the side and keeps the cover probability',
  mirror.side !== direct.side && near(mirror.cover_probability, direct.cover_probability, 0.02));
var alt = E.decide(p, { books: [{ home_line: -3 }, { home_line: -3.5 }, { home_line: -3 }, { home_line: 10, alternate: true }],
  ts: '2026-10-01T14:30:00Z', price_home: -110, price_away: -110 }, { now: NOW, row: ROW });
chk('alternate spreads never enter the consensus', alt.current_home_line === -3 && alt.books === 3);

/* ------------------------------------------------------ monotonicity */
var probs = [-14, -7, -3, 0, 3, 7, 14].map(function (m) {
  return E.pure(Object.assign(clone(ROW), { ens_pred: m }), { qb_status: { home: 'confirmed', away: 'confirmed' } }).home_win_prob;
});
chk('calibrated win probability is monotone in the margin', probs.every(function (x, i) { return i === 0 || x >= probs[i - 1]; }));
var covers = [-14, -7, -3, 0, 3, 7, 14].map(function (l) {
  var d = E.decide(p, mkt(l), { now: NOW, row: ROW });
  return d.side === 'HOME' ? d.cover_probability : 1 - d.cover_probability;
});
chk('home cover probability rises as the home line gets easier', covers.every(function (x, i) { return i === 0 || x >= covers[i - 1] - 1e-9; }));

/* ------------------------------------------------------ determinism */
chk('same inputs, same outputs', JSON.stringify(E.pure(ROW, {})) === JSON.stringify(E.pure(ROW, {}))
  && JSON.stringify(E.decide(p, mkt(-3), { now: NOW, row: ROW })) === JSON.stringify(E.decide(p, mkt(-3), { now: NOW, row: ROW })));
chk('t CDF is symmetric and correct at 0', near(E.tCdf(0, 8), 0.5, 1e-12) && near(E.tCdf(1.2, 8) + E.tCdf(-1.2, 8), 1, 1e-10));

/* ------------------------------------------------------ card language */
var c = E.card(p, d1);
chk('card carries the research status and the pure block', !!c.research_status && !!c.pure.fair_spread);
chk('card language never says lock / guaranteed / cant miss', !/lock|guarantee|can'?t miss/i.test(JSON.stringify(c)));
chk('missing snapshot is INSUFFICIENT_DATA, not a number', E.pure(null, {}).status === 'INSUFFICIENT_DATA');
var fcs = E.pure(Object.assign(clone(ROW), { fcs_game: true }), {});
chk('FCS flag alone still caps confidence', fcs.football_prediction_confidence <= P.reliability.caps.fcs);
var np_ = E.pure(Object.assign(clone(ROW), { fcs_game: true, priced: false, not_priced_reason: 'FBS-vs-FCS' }), {});
chk('an unpriced FBS-vs-FCS row returns NOT_PRICED and no number', np_.status === 'NOT_PRICED' && !('projected_margin' in np_));
chk('a NOT_PRICED projection cannot be decided on', E.decide(np_, mkt(-30), { now: NOW, row: ROW }).status === 'PASS');

console.log((n - fail) + '/' + n + ' passed');
process.exit(fail ? 1 : 0);
