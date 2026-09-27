#!/usr/bin/env node
/* ===========================================================================
   The decision engine's production-integrity gates (football/cfb_decision/
   decision.js; docs/cfb-production/MARKET_INTEGRITY.md §8). Known answers:

   - an impossible quote is PASS_MARKET_INVALID and no number is computed
     from it: a +450 spread, American odds of 0, a price inside (-100, +100),
     a quote from the future, a two-way price below fair;
   - freshness is the quote's TRUE age: a heartbeat of a book whose
     provider_updated_at is 5 h old is PASS_MARKET_STALE;
   - decideGame assesses the consensus: one book cannot carry a BET
     (PASS_MARKET_DEGRADED), a cross-book outlier is isolated and itself never
     actionable (PASS_MARKET_INVALID), the other books decide on their merits;
   - the team join goes through the identity master ("Texas Tech Red
     Raiders" is Texas Tech; "Texas" is not);
   - the extreme-probability diagnostic runs the QB/freshness checks without
     capping a clean case;
   - LEAN / RESEARCH / PASS are never changed by the BET gate.

   Run: node football/cfb_decision/integrity_gates.test.js
   =========================================================================== */
'use strict';
const D = require('./decision.js');

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push(name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 300) : '')); }

const NOW = Date.parse('2026-10-01T15:00:00.000Z');
const ART = {
  schema: 'cfb_decision_calibration_schema_v1', version: 'test_artifact', base_model_version: 'edgedesk_cfb_v2.1.0',
  cover_calibration: { map: { method: 'platt', a: 0, b: 0.6 } }, market_shrinkage: { w_model: 0.85, space: 'logit' },
  ev_curve: { x: [-0.2, 0, 0.1, 0.3], y: [-0.2, 0, 0.06, 0.12] },
  p_positive_clv: { type: 'logistic', intercept: 0, coef: { gap_pts: 0.2 } }, clv_magnitude: { type: 'linear', intercept: 0, coef: { gap_pts: 0.3 } },
  push_table: { '0-2.5': 0.01, '2.5-3.5': 0.09, '3.5-6.5': 0.03, '6.5-7.5': 0.06, '7.5-13.5': 0.03, '13.5-99': 0.028 },
  reliability_scale: { expected_abs_error: { x: [0, 50, 100], y: [16, 12, 9] } }
};
const POL = {
  version: 'test_policy', bet_enabled: true, min_probability_edge: 0.02, min_ev: 0.02, stale_minutes: 180,
  max_price: -125, max_dispersion_iqr: 1.5, min_books: 3, min_football_confidence: 30, max_ensemble_sd: 6,
  extreme_gap_pts: 10, extreme_ev: 0.15, extreme_max_age_minutes: 60,
  lean: { min_probability_edge: 0, min_gap_pts: 1 }, hysteresis: { ev_buffer: 0.004, edge_buffer: 0.004 },
  wait: { enabled: false }, reference_price: -110, stake: { method: 'flat', unit_u: 1, max_stake_u: 1 },
  exposure: { max_game_u: 1.5, max_slate_u: 3, same_game_correlation: 1 }
};
const pure = (o) => Object.assign({ status: 'PREDICTED', game_id: '401', model_version: 'edgedesk_cfb_v2.1.0', home: 'Texas Tech', away: 'Baylor',
  projected_margin: 9.5, sigma: 15.0, t_df: 100, football_prediction_confidence: 70, ensemble_sd: 2.0, week: 6, kickoff: '2026-10-03T19:30:00.000Z', fair_spread_display: 'Texas Tech -9.5' }, o || {});
const quote = (o) => Object.assign({ game_id: '401', book: 'bookA', home_team: 'Texas Tech', home_line: -3.5, price_home: -110, price_away: -110,
  observed_at: '2026-10-01T14:50:00.000Z', market_type: 'spread' }, o || {});
const ctx = (o) => Object.assign({ policy: POL, artifact: ART, now: NOW, market: { books: 6, dispersion_iqr: 0.5 }, row: {} }, o || {});

/* the baseline this file protects: the fixture quote IS a BET */
const base = D.decideQuote(pure(), quote(), ctx());
chk('baseline: the clean fixture quote is a BET (so each gate below is what changed it)', base.status === 'BET', base.reason_codes);

/* ═══ impossible quotes ═══════════════════════════════════════════════ */
const inv = (q) => D.decideQuote(pure(), quote(q), ctx());
const d450 = inv({ home_line: 450 });
chk('a +450 spread is PASS_MARKET_INVALID and carries no computed number', d450.status === 'PASS' && d450.reason_codes[0] === 'PASS_MARKET_INVALID'
  && d450.decision_cover_probability === undefined && /SPREAD_OUT_OF_BOUNDS/.test(d450.detail), d450);
chk('American odds of 0 are PASS_MARKET_INVALID', inv({ price_home: 0 }).reason_codes[0] === 'PASS_MARKET_INVALID');
chk('a price of -50 is PASS_MARKET_INVALID', inv({ price_away: -50 }).reason_codes[0] === 'PASS_MARKET_INVALID');
chk('a quote observed an hour after the decision time is PASS_MARKET_INVALID (never "fresh")', inv({ observed_at: '2026-10-01T16:00:00.000Z' }).reason_codes[0] === 'PASS_MARKET_INVALID');
chk('both sides +300 (a book paying above fair on both) is PASS_MARKET_INVALID', inv({ price_home: 300, price_away: 300 }).reason_codes[0] === 'PASS_MARKET_INVALID');
chk('a -58.5 line (a real FBS-FCS number) is NOT refused by the bounds', inv({ home_line: -58.5 }).reason_codes[0] !== 'PASS_MARKET_INVALID');

/* ═══ true freshness ══════════════════════════════════════════════════ */
const stale = D.decideQuote(pure(), quote({ provider_updated_at: '2026-10-01T10:00:00.000Z' }), ctx());
chk('observed 10 minutes ago but last updated by the provider 5 h ago: PASS_MARKET_STALE', stale.status === 'PASS' && stale.reason_codes[0] === 'PASS_MARKET_STALE' && stale.market_confidence.age_minutes === 300, stale.market_confidence);
chk('a provider update older than our observation within the limit changes nothing', D.decideQuote(pure(), quote({ provider_updated_at: '2026-10-01T14:40:00.000Z' }), ctx()).status === 'BET');

/* ═══ consensus integrity in decideGame ═══════════════════════════════ */
const one = D.decideGame(pure(), { books: 6, dispersion_iqr: 0.5, quotes: [quote({ book: 'A' })] }, ctx());
chk('one quote cannot carry a BET: PASS_MARKET_DEGRADED (the game has no BET)', one.status !== 'BET' && one.by_book[0].reason_codes[0] === 'PASS_MARKET_DEGRADED', one.by_book);
const four = D.decideGame(pure(), { books: 6, dispersion_iqr: 0.5, quotes: [quote({ book: 'A' }), quote({ book: 'B', home_line: -3 }), quote({ book: 'C', home_line: -3.5 }), quote({ book: 'D', home_line: 4.5 })] }, ctx());
const byB = Object.fromEntries(four.by_book.map((b) => [b.book, b]));
chk('an outlier book (+4.5 against -3/-3.5) is isolated: PASS_MARKET_INVALID, never the best quote', byB.D.status === 'PASS' && byB.D.reason_codes[0] === 'PASS_MARKET_INVALID' && (!four.best_quote || four.best_quote.book !== 'D'), four.by_book);
chk('... while the agreeing books decide on their merits (a BET survives)', four.status === 'BET' && ['A', 'B', 'C'].some((b) => byB[b].status === 'BET'), four.by_book);
const stal = D.decideGame(pure(), { books: 6, dispersion_iqr: 0.5, quotes: [quote({ book: 'A', provider_updated_at: '2026-10-01T10:30:00.000Z' }), quote({ book: 'B', provider_updated_at: '2026-10-01T10:30:00.000Z' })] }, ctx());
chk('every book stale by provider time: no BET anywhere', stal.status !== 'BET' && stal.by_book.every((b) => b.status !== 'BET'), stal.by_book);
const given = D.decideGame(pure(), { books: 6, dispersion_iqr: 0.5, integrity: { status: 'OK', actionable_status: 'ACTIONABLE', reasons: [], quarantined_quote_ids: [] }, quotes: [quote({ book: 'A' })] }, ctx());
chk('a caller-assessed ACTIONABLE market is respected (not re-assessed)', given.status === 'BET', given.by_book);

/* ═══ the team join through the identity master ═══════════════════════ */
const j1 = D.decideQuote(pure(), quote({ home_team: 'Texas Tech Red Raiders' }), ctx());
chk('"Texas Tech Red Raiders" joins to Texas Tech (a book name is not a mapping fault)', !j1.integrity.failures.some((f) => /^join/.test(f)) && j1.status === 'BET', j1.integrity);
const j2 = D.decideQuote(pure(), quote({ home_team: 'Texas Longhorns' }), ctx());
chk('"Texas Longhorns" is NOT Texas Tech: PASS_DATA_QUALITY', j2.status === 'PASS' && j2.reason_codes[0] === 'PASS_DATA_QUALITY' && j2.integrity.failures.some((f) => /^join/.test(f)), j2.integrity);
const j3 = D.decideQuote(pure({ home: 'Miami' }), quote({ home_team: 'Miami (OH)' }), ctx());
chk('"Miami (OH)" is never Miami', j3.reason_codes[0] === 'PASS_DATA_QUALITY');

/* ═══ extreme cover probability (diagnostic, not a cap) ═══════════════ */
const sharp = pure({ projected_margin: 3, sigma: 5 });
const ep = D.decideQuote(sharp, quote({ home_line: -0.5 }), ctx());
chk('a decision cover probability above 0.60 with a gap under 10 triggers the probability diagnostic', ep.integrity.extreme_probability === true && ep.integrity.extreme === false && ep.decision_cover_probability >= 0.6, [ep.decision_cover_probability, ep.integrity]);
chk('... a clean case is not capped or pushed to RESEARCH by it (it stays a BET)', ep.status === 'BET' && !ep.reason_codes.includes('RESEARCH_EXTREME_EDGE'), ep.reason_codes);
const epq = D.decideQuote(sharp, quote({ home_line: -0.5 }), ctx({ row: { qb_unsettled_any: true } }));
chk('... but an unsettled QB behind that probability fails the integrity check: PASS_DATA_QUALITY', epq.status === 'PASS' && epq.reason_codes[0] === 'PASS_DATA_QUALITY', epq.integrity);
const eps = D.decideQuote(sharp, quote({ home_line: -0.5, observed_at: '2026-10-01T13:30:00.000Z' }), ctx());
chk('... and so does a 90-minute-old quote', eps.reason_codes[0] === 'PASS_DATA_QUALITY', eps.integrity);

/* ═══ the gate only touches BET ═══════════════════════════════════════ */
const off = D.decideGame(pure(), { books: 6, dispersion_iqr: 0.5, quotes: [quote({ book: 'A' })] }, ctx({ policy: Object.assign({}, POL, { bet_enabled: false }) }));
chk('with betting disabled a single book is still LEAN (the consensus gate never downgrades a non-BET)', off.by_book[0].status === 'LEAN', off.by_book);
chk('the explanation of an invalid market names it', /market validation/.test(D.explain(d450)));

failures.forEach((f) => console.log('FAIL | ' + f));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
