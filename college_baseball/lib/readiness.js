'use strict';
/* ===========================================================================
   EdgeDesk college baseball — research readiness, one game at a time
   (Phase 12). SEVEN SEPARATE STATES, never one score:

     DATA_AVAILABLE    the game and both programs are identified, with history
     MODEL_ELIGIBLE    minimum data-quality and coverage requirements are met
     PRICE_GENERATED   a model produced a coherent probability distribution
     PROVISIONAL       an important input or validation remains uncertain
     MARKET_VERIFIED   a current, authorised sportsbook quote exists
     VALUE_EVALUATED   model and market compared under matching settlement
     RESEARCH_BLOCKED  missing or contradictory data prevents a defensible number

   A game can have a price and no market (the normal case here); a game with
   a market can still fail MODEL_ELIGIBLE. Every false state carries reasons.
   =========================================================================== */
const THRESHOLDS = {
  min_info: 1.0,              // Fisher information on a team's net strength (about 4-5 games' worth)
  max_sd_delta: 0.30,         // posterior sd of the rating gap (log runs)
  max_mc_se: 0.01,            // simulator standard error on the first-five price (full-game prices are exact)
};

function assess(g, ctx) {
  ctx = ctx || {};
  const reasons = {}; const add = (k, why) => { (reasons[k] = reasons[k] || []).push(why); };
  /* DATA_AVAILABLE */
  const data = !!(g.home_id && g.away_id);
  if (!g.home_id) add('DATA_AVAILABLE', 'home program not identified in the NCAA team lookup'); if (!g.away_id) add('DATA_AVAILABLE', 'road program not identified in the NCAA team lookup');
  /* RESEARCH_BLOCKED */
  let blocked = false;
  if (g.quality === 'CONFLICT') { blocked = true; add('RESEARCH_BLOCKED', 'sources disagree on a critical field; the game is quarantined'); }
  if (!data) { blocked = true; add('RESEARCH_BLOCKED', 'a program is unidentified'); }
  if (g.status === 'CANCELED' || g.status === 'POSTPONED') { blocked = true; add('RESEARCH_BLOCKED', 'the game is ' + g.status.toLowerCase()); }
  /* MODEL_ELIGIBLE */
  const m = ctx.team || {};
  let eligible = data && !blocked;
  if (eligible && m.info_min != null && m.info_min < THRESHOLDS.min_info && !m.has_prior) { eligible = false; add('MODEL_ELIGIBLE', 'a program has too little history this season and no prior season'); }
  if (eligible && !ctx.model_ok) { eligible = false; add('MODEL_ELIGIBLE', 'the team model produced no expectation'); }
  /* PRICE_GENERATED */
  const priced = eligible && !!(ctx.price && ctx.coherence && ctx.coherence.ok);
  if (eligible && ctx.price && ctx.coherence && !ctx.coherence.ok) add('PRICE_GENERATED', 'incoherent markets: ' + ctx.coherence.errors.join('; '));
  if (eligible && !ctx.price) add('PRICE_GENERATED', 'pricing failed: ' + (ctx.price_error || 'unknown'));
  /* PROVISIONAL */
  let provisional = false;
  const pv = (why) => { provisional = true; add('PROVISIONAL', why); };
  if (ctx.model_status !== 'OUTCOME_VALIDATED') pv('the moneyline model is not OUTCOME_VALIDATED on the holdout (' + (ctx.model_status || 'not assessed') + ')');
  if (ctx.release_gate_failures && ctx.release_gate_failures.length) pv('release gates failing: ' + ctx.release_gate_failures.join(', '));
  if (m.sd_delta != null && m.sd_delta > THRESHOLDS.max_sd_delta) pv('rating uncertainty is high (sd ' + Math.round(m.sd_delta * 100) / 100 + ')');
  if (ctx.starters && (ctx.starters.home !== 'CONFIRMED' || ctx.starters.away !== 'CONFIRMED')) pv('starting pitchers not confirmed (home ' + ctx.starters.home + ', road ' + ctx.starters.away + ')');
  if (ctx.mc_se != null && ctx.mc_se > THRESHOLDS.max_mc_se) pv('simulation error above ' + THRESHOLDS.max_mc_se);
  if (g.home_basis === 'FIRST_LISTED' || g.quality === 'VERIFIED_MIRROR') pv('which side bats last is not confirmed by a second source');
  if (g.dh) pv('doubleheader: the scheduled length (seven or nine) is a probability, not a fact');
  if (/^SINGLE_SOURCE/.test(g.quality || '')) pv('the schedule row has a single source');
  /* MARKET */
  const market = !!(ctx.quote && ctx.quote.authorised);
  if (!market) add('MARKET_VERIFIED', ctx.market_reason || 'no authorised college-baseball sportsbook feed: the odds gateway does not carry baseball_ncaa');
  const value = market && ctx.settlement_verified === true && priced;
  if (!value) add('VALUE_EVALUATED', market ? 'settlement rules not verified for the quoting book' : 'no market to compare against');
  const states = { DATA_AVAILABLE: data, MODEL_ELIGIBLE: eligible, PRICE_GENERATED: priced, PROVISIONAL: priced ? provisional : null, MARKET_VERIFIED: market, VALUE_EVALUATED: value, RESEARCH_BLOCKED: blocked };
  return { states, reasons, label: blocked ? 'RESEARCH BLOCKED' : !priced ? 'NOT PRICED' : value ? 'VALUE EVALUATED' : provisional ? 'PROVISIONAL RESEARCH' : 'RESEARCH PRICE' };
}

module.exports = { assess, THRESHOLDS };
