#!/usr/bin/env node
/* ===========================================================================
   Tests for lib/edgedesk_canon.js — the one vocabulary every surface reads.

   What must never drift:
     1  the two ratings have distinct names, and only the PRODUCTION PRICING
        STATE prices games; the explanation between them uses the engine's
        actual structure and nothing else;
     2  the research status is one rule, first match wins, and it is the same
        rule for the terminal object and a hand-built input;
     3  the decision status is separate: VERIFIED never implies BET, a BET
        cannot appear while betting is disabled, WAIT cannot appear while the
        policy's WAIT rule is disabled, and an unevaluated game is NO DECISION;
     4  the counter hierarchy reconciles and every counter is defined;
     5  maturity and validation badges are earned under stated rules, never
        from merely having results;
     6  the pricing-input panel never lists the market as an input.

   Run: node tools/validation/canon.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const C = require(path.join(ROOT, 'lib', 'edgedesk_canon.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 260); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function eq(name, got, want) { chk(name, got === want, 'got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want)); }

/* 1. ratings */
const R = C.RATINGS;
eq('current rating label', R.CURRENT_FBS_POWER_RATING.label, 'CURRENT FBS POWER RATING');
eq('pricing state label', R.PRODUCTION_PRICING_STATE.label, 'PRODUCTION PRICING STATE');
chk('the two names cannot be confused', R.CURRENT_FBS_POWER_RATING.label !== R.PRODUCTION_PRICING_STATE.label
  && !/ENGINE STATE|EDGEDESK FBS RATING/.test(R.CURRENT_FBS_POWER_RATING.label + R.PRODUCTION_PRICING_STATE.label));
eq('only the pricing state prices games', R.PRODUCTION_PRICING_STATE.prices_games && !R.CURRENT_FBS_POWER_RATING.prices_games, true);
eq('the current rating is shadow research', R.CURRENT_FBS_POWER_RATING.maturity, 'SHADOW');
eq('prior weight at 4 games is the shipped 0.8', C.priorWeightAt(4), 0.8);
eq('prior weight at 9 games falls back to the 6+ value', C.priorWeightAt(9), 0.6);
const pair = C.ratingPair({ team: 'Iowa State',
  current: { rating: 8.5, components: { results: { rating: 10.1, weight: 0.57, games: 4 }, carryover: { applied: 6.2 }, roster: { points: 2.4, available: true }, availability: { contribution: 0 } } },
  state: { value: 18.9, carried: 20.1, this_season: 14.1, prior_weight: 0.8, games_played: 4 },
  centers: { current: 0, state: -2.4 } });
eq('difference is pricing state minus current rating', pair.difference, 10.4);
eq('scale offset reported', pair.center_offset, -2.4);
eq('team divergence is centered current minus centered state', pair.divergence, -12.8);
chk('why names the learned blend', pair.why.some((w) => /80% the long-run trained state/.test(w) && /4 games played/.test(w)));
chk('why names the roster term as unpriced', pair.why.some((w) => /roster\/talent term of \+2\.4/.test(w) && /enters no production price/.test(w)));
chk('why names the scale offset', pair.why.some((w) => /different FBS average/.test(w)));
eq('a -12.8 team divergence is LARGE on the default bands', pair.band, 'LARGE');
eq('LARGE is not expected', pair.expected, false);
chk('the pair states which one prices', pair.prices === 'PRODUCTION PRICING STATE');
chk('a missing state is said, not invented', C.ratingPair({ current: { rating: 3 }, state: {} }).why[0].indexOf('no production pricing state') >= 0);
const gd = C.gameDivergence({ current_home: 5, current_away: -3, state_home: 1, state_away: 0 });
eq('game divergence = current gap − state gap', gd.divergence, 7);
eq('7 pts is MODERATE on the fitted game bands (large ≥ 7.22)', gd.band, 'MODERATE');
eq('game divergence flags only LARGE', C.gameDivergence({ current_home: 10, current_away: 0, state_home: 1, state_away: 0 }).flag, true);

/* 2. research status: the rule order */
function rs(x) { return C.researchStatus(Object.assign({ projected: true, market: 'FRESH', confidence: 70, reliability: 80, fair_margin: 5 }, x)).key; }
eq('fault first', rs({ fault: 'mis-joined line', gap: 3 }), 'DATA_FAULT');
eq('no projection', rs({ projected: false }), 'LIMITED_DATA');
eq('gate data fault', rs({ gap: 9, verification: 'DATA_FAULT' }), 'DATA_FAULT');
eq('unverified past the guard', rs({ gap: 22, verification: 'UNVERIFIED' }), 'DATA_FAULT');
eq('verified past the guard stays verified', rs({ gap: 22, verification: 'VERIFIED' }), 'VERIFIED_MAJOR');
eq('no quote', rs({ market: 'NONE', gap: null }), 'NO_MARKET');
eq('stale quote is NO MARKET (one word everywhere)', rs({ market: 'STALE', gap: 5 }), 'NO_MARKET');
eq('7+ verified', rs({ gap: 8, verification: 'VERIFIED' }), 'VERIFIED_MAJOR');
eq('7+ market fault', rs({ gap: 8, verification: 'MARKET_FAULT' }), 'MARKET_FAULT');
eq('7+ anything else', rs({ gap: 8, verification: 'UNVERIFIED' }), 'INVESTIGATE');
eq('7+ with no gate result fails closed', rs({ gap: 8 }), 'INVESTIGATE');
eq('low confidence', rs({ gap: 4, confidence: 20 }), 'LIMITED_DATA');
eq('unmeasured confidence is thin', rs({ gap: 4, confidence: null }), 'LIMITED_DATA');
eq('low reliability', rs({ gap: 4, reliability: 50 }), 'LIMITED_DATA');
eq('a 6-pt gap on a near pick’em is WORTH RESEARCHING', rs({ gap: 6.2, fair_margin: 0.2 }), 'WORTH_RESEARCHING');
eq('near pick’em inside the research gap', rs({ gap: 1.2, fair_margin: 0.3 }), 'NEAR_PICKEM');
eq('aligned', rs({ gap: 1.2, fair_margin: 6 }), 'MARKET_ALIGNED');
chk('every research status is defined', C.RESEARCH_KEYS.every((k) => C.RESEARCH_STATUS[k] && C.RESEARCH_STATUS[k].means && C.RESEARCH_STATUS[k].label));
eq('legacy LOW RELIABILITY maps to LIMITED DATA', C.fromResearchView({ key: 'LOW_RELIABILITY' }), 'LIMITED_DATA');
eq('legacy stale LIMITED DATA maps to NO MARKET', C.fromResearchView({ key: 'LIMITED_DATA', rule: 'stale_market' }), 'NO_MARKET');
eq('legacy VERIFIED maps to VERIFIED_MAJOR', C.fromResearchView({ key: 'VERIFIED_MAJOR_DISAGREEMENT' }), 'VERIFIED_MAJOR');

/* 3. decision status */
eq('no engine verdict is NO DECISION', C.decisionStatus(null, {}, false).key, 'NO_DECISION');
eq('an unevaluated NO_BET is NO DECISION, not PASS', C.decisionStatus({ status: 'NO_BET', reasons: ['no quote'] }, {}, false).key, 'NO_DECISION');
eq('an evaluated NO_BET is PASS', C.decisionStatus({ status: 'NO_BET', reasons: ['edge too small'] }, {}, true).key, 'PASS');
eq('BET while betting is disabled cannot show', C.decisionStatus({ status: 'BET' }, { bet_enabled: false }, true).key, 'PASS');
eq('WAIT while the WAIT rule is disabled cannot show', C.decisionStatus({ status: 'WAIT' }, { wait_enabled: false }, true).key, 'PASS');
eq('BET when the engine certifies and policy allows', C.decisionStatus({ status: 'BET' }, { bet_enabled: true }, true).key, 'BET');
chk('VERIFIED never implies BET: a verified research status carries no decision', (function () {
  const r = C.researchStatus({ projected: true, market: 'FRESH', gap: 9, verification: 'VERIFIED', confidence: 80, reliability: 90 });
  return r.key === 'VERIFIED_MAJOR' && !('decision' in r) && C.DECISION_KEYS.indexOf(r.key) < 0;
})());
chk('research and decision keys never overlap', C.RESEARCH_KEYS.every((k) => C.DECISION_KEYS.indexOf(k) < 0));
const wnb = C.whyNotBet({ bet_enabled: false, cover: 0.530, break_even: 0.524, expected_error: 12.2, research_status: 'WORTH_RESEARCHING' });
chk('why-not-bet states cover vs break-even with the numbers', wnb.some((r) => /53\.0%/.test(r.text) && /52\.4%/.test(r.text)));
chk('why-not-bet names the policy switch', wnb.some((r) => r.code === 'BETTING_DISABLED'));

/* price state */
eq('MOST_GONE -> EDGE MOSTLY PRICED IN', C.priceState({ available: true, verdict: 'MOST_GONE' }).label, 'EDGE MOSTLY PRICED IN');
eq('REVERSED -> PRICE NO LONGER ATTRACTIVE', C.priceState({ available: true, verdict: 'REVERSED' }).label, 'PRICE NO LONGER ATTRACTIVE');
eq('INTACT -> PRICE STILL AVAILABLE', C.priceState({ available: true, verdict: 'INTACT' }).key, 'AVAILABLE');
eq('no history -> UNKNOWN', C.priceState({ available: false }).key, 'UNKNOWN');

/* favorite flip */
eq('flip', C.favoriteFlip(3, -4), true);
eq('same favourite', C.favoriteFlip(3, 10), false);
eq('a half-point side is not a flip', C.favoriteFlip(0.3, -4), false);

/* 4. counters */
const h = C.counterHierarchy([
  { sport: 'cfb', research_status: 'VERIFIED_MAJOR' }, { sport: 'cfb', research_status: 'MARKET_FAULT' }, { sport: 'cfb', research_status: 'INVESTIGATE' },
  { sport: 'cfb', research_status: 'WORTH_RESEARCHING' }, { sport: 'cfb', research_status: 'NEAR_PICKEM' }, { sport: 'cfb', research_status: 'NO_MARKET' },
  { sport: 'cfb', research_status: 'LIMITED_DATA' }, { sport: 'cfb', research_status: 'DATA_FAULT' }, { sport: 'nfl', research_status: 'WORTH_RESEARCHING' },
  { sport: 'nfl', research_status: 'NO_MARKET' }]);
eq('all games', h.all, 10);
eq('research ready excludes NO MARKET, LIMITED and DATA FAULT', h.ready, 6);
eq('actionable is VERIFIED MAJOR + WORTH RESEARCHING only', h.actionable, 3);
eq('INVESTIGATE counter includes MARKET FAULT', h.cfb_buckets.INVESTIGATE, 2);
eq('MARKET ALIGNED counter includes NEAR PICK’EM', h.cfb_buckets.MARKET_ALIGNED, 1);
eq('the CFB buckets reconcile to the CFB total', h.reconciles, true);
eq('NFL ready', h.by_sport.nfl.ready, 1);
chk('every counter answers population, threshold, sport and status', Object.keys(C.COUNTERS).every((k) => {
  const c = C.COUNTERS[k]; return c.label && c.population && c.threshold && c.sport && c.status && c.means;
}));

/* 5. maturity and badges */
chk('every module has a known maturity and a yes/no pricing impact', C.MODULES.every((m) => C.MATURITY[m.maturity] && typeof m.pricing_impact === 'boolean' && m.reason));
eq('player quality moves no line', C.module('player_quality').pricing_impact, false);
eq('ETSR moves no line', C.module('etsr').pricing_impact, false);
eq('V1 moves the line', C.module('cfb_v1').pricing_impact, true);
eq('V1 is PRODUCTION, not PRODUCTION VALIDATED, without live evidence', C.module('cfb_v1').maturity, 'PRODUCTION');
eq('pricing impact text', C.pricingImpactText(C.module('player_quality')).text, 'RESEARCH CONTEXT ONLY');
chk('no module claims PRODUCTION VALIDATED statically', C.MODULES.every((m) => m.maturity !== 'PRODUCTION_VALIDATED'));
let b = C.validationBadges({ tracked_live_n: 59, settled_live_n: 0, makes_price_claims: true, clv_n: 0 });
chk('tracked is earned by method', b.some((x) => x.key === 'WALK_FORWARD_TRACKED' && x.earned));
chk('validated is not earned from results alone', b.some((x) => x.key === 'WALK_FORWARD_VALIDATED' && !x.earned));
chk('CLV pending under 200', b.some((x) => x.key === 'CLV_PENDING'));
b = C.validationBadges({ tracked_live_n: 800, settled_live_n: 750, mae_diff_ci: [-0.4, -0.05], ece: 0.02, cov80: 0.8, makes_price_claims: true, clv_n: 250, clv_ci: [0.1, 0.6] });
chk('validated when every rule holds', b.some((x) => x.key === 'WALK_FORWARD_VALIDATED' && x.earned));
chk('CLV validated when every rule holds', b.some((x) => x.key === 'CLV_VALIDATED' && x.earned));
b = C.validationBadges({ tracked_live_n: 800, settled_live_n: 750, mae_diff_ci: [-0.4, 0.05], ece: 0.02, cov80: 0.8 });
chk('a CI that crosses zero does not validate', b.some((x) => x.key === 'WALK_FORWARD_VALIDATED' && !x.earned));

/* 6. pricing inputs */
const pi = C.pricingInputs([{ key: 'rating', points: -3.1 }, { key: 'hfa', points: 4.08 }, { key: 'matchup', points: -0.4 }], { neutral: false });
chk('the market is never a pricing input', pi.rows.some((r) => r.key === 'market' && !r.priced));
chk('ETSR is shown as unpriced in shadow mode', pi.rows.some((r) => r.key === 'etsr' && !r.priced));
chk('player quality is shown as unpriced', pi.rows.some((r) => r.key === 'player_quality' && !r.priced));
chk('the trained team state is priced', pi.rows.some((r) => r.key === 'rating' && r.priced && r.points === -3.1));
chk('a QB absence of 0 is inactive and says why', pi.rows.some((r) => r.key === 'injury' && !r.active && /no quarterback absence/.test(r.note)));
eq('independence headline', pi.independence, 'SPORTSBOOK MARKET DOES NOT ENTER THE PURE EDGEDESK FAIR LINE.');
chk('ETSR becomes priced only when promoted', C.pricingInputs([], { canonical_mode: 'PRICED_CANONICAL' }).rows.some((r) => r.key === 'etsr' && r.priced));

/* the object is frozen: no page can rewrite a definition */
chk('the canon is frozen', Object.isFrozen(C) && Object.isFrozen(C.RESEARCH_STATUS) && Object.isFrozen(C.MODULES));
chk('one canonical disclaimer, naming what the product does', typeof C.DISCLAIMER === 'string' && /research and decision-support tool/.test(C.DISCLAIMER) && !/nothing on it is a recommendation to bet/.test(C.DISCLAIMER));

if (fail) { console.log(failures.map((f) => 'FAIL | ' + f).join('\n')); console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(1); }
console.log('ALL GREEN ' + pass + ' passed, 0 failed');
