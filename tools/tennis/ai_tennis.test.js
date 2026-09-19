#!/usr/bin/env node
/* ===========================================================================
   Tests for the TENNIS AI retrieval layer
   (supabase/functions/edgedesk_ai/_tennis.js).

   The assistant is the surface where a model is most tempted to improvise, so
   these are the questions asked of it:

     do all NINE product questions route to a retrieval?
     does a tennis question get recognised without swallowing a football one?
     is every answer about a current match forced to carry the five things —
       data timestamp, market timestamp, model version, what is missing, and
       whether the match passes the research gates?
     is a FAILED retrieval reported as a failure rather than as an empty result?
     is an UNENTITLED empty result distinguished from "EdgeDesk found nothing"?
     does an indoor match get told weather does not apply, rather than that it
       is missing?
     are the prohibitions the model is held to actually present in the prompt?

   Run: node tools/tennis/ai_tennis.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const T = require('../../supabase/functions/edgedesk_ai/_tennis.js');

let pass = 0, fail = 0; const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 300); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function eq(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  chk(name, a === b, 'got ' + a + ', want ' + b);
}
function has(hay, needle, name) { chk(name, String(hay).indexOf(needle) >= 0, 'missing: ' + needle); }

/* ── 1. THE NINE QUESTIONS ────────────────────────────────────────────── */
const NINE = [
  ['Who is the strongest player on clay right now?', 'surface_strength'],
  ['Which ATP or WTA matches show the largest model/market disagreement?', 'disagreement'],
  ["Is this player's current form sustainable?", 'form_sustainable'],
  ['How much does this surface change the matchup?', 'surface_effect'],
  ['Is fatigue or travel meaningful here?', 'fatigue'],
  ['What does the market price imply?', 'market_read'],
  ['Why is EdgeDesk different from the market?', 'why_different'],
  ['What information is missing?', 'whats_missing'],
  ['What are the best tennis matches to research today?', 'best_to_research']
];
NINE.forEach(([q, intent]) => {
  const c = T.classifyTennis(q);
  chk('"' + q.slice(0, 48) + '" routes to ' + intent, c.intents.indexOf(intent) >= 0, JSON.stringify(c.intents));
  chk('and asks for at least one retrieval', c.needs.length > 0);
});
chk('an unrecognised tennis question still asks for the health line and the board', () => {
  const c = T.classifyTennis('tell me about tennis');
  return c.needs.indexOf('health') >= 0 && c.needs.indexOf('disagreement') >= 0;
});

/* ── 2. IS THIS EVEN A TENNIS QUESTION ────────────────────────────────── */
chk('an ATP question is tennis', T.isTennisQuestion('who is the ATP favourite'));
chk('a Wimbledon question is tennis', T.isTennisQuestion('what about Wimbledon'));
chk('a routed sport key is tennis', T.isTennisQuestion('anything', 'tennis_wta'));
chk('a football question is NOT tennis', !T.isTennisQuestion('who should start at quarterback'));
chk('a bare "clay" is not enough on its own', !T.isTennisQuestion('clay pigeon shooting scores'));
eq('the tour is read where it is stated', T.detectTour('the WTA draw'), 'WTA');
eq('and left null where it is not', T.detectTour('the draw'), null);
eq('the surface is read where it is stated', T.detectSurface('on grass'), 'grass');
eq('and left null where it is not', T.detectSurface('a match'), null);

/* ── 3. RETRIEVAL: a fake rpc, and what happens to each answer ────────── */
function fakeRpc(map, failing) {
  return async function (name, args) {
    if (failing && failing.indexOf(name) >= 0) throw new Error('permission denied for function ' + name);
    return map[name] === undefined ? null : map[name];
  };
}
const HEALTH = { health: { matches: 361571, ratings_computed_at: '2026-09-19T04:00:00Z',
  active_model_version: 'tennis-baseline-1.0.0', open_data_issues: 0 },
  licences: [{ source_key: 'archive', licence: 'CC BY-NC-SA 4.0', commercial_use: false }] };
const MATCH_ENTITLED = {
  match: { match_ref: 'espn:1', surface: 'clay', environment: 'outdoor' },
  entitled: true,
  prediction: { model_version: 'tennis-baseline-1.0.0', feature_snapshot_at: '2026-09-19T04:00:00Z',
    prob_a: 0.64, research_grade: 'research', exclusion_reasons: [], missing_inputs: ['d_serve_strength'] },
  market: [{ sportsbook: 'draftkings', captured_at: '2026-09-19T11:30:00Z', implied_prob: 0.58 }],
  weather: { temporal_precision: 'tournament_week', usable: false, environment: 'outdoor' },
  health: HEALTH.health
};

(async function () {
  /* the complete, entitled case */
  let r = await T.retrieveTennis(fakeRpc({ ai_match_context: MATCH_ENTITLED, ai_data_health: HEALTH }),
    'what does the market price imply?', { match_ref: 'espn:1' });
  const c = r.contract;
  chk('the contract carries a data timestamp', !!c.data_timestamp);
  chk('and a market timestamp', !!c.market_timestamp);
  chk('and the model version', c.model_version === 'tennis-baseline-1.0.0');
  chk('and whether the match passes the research gates', c.passes_research_gates === true);
  chk('and what is missing', Array.isArray(c.missing));
  chk('a missing model input is named in the contract',
      c.missing.some(x => /serve strength/.test(x)), JSON.stringify(c.missing));
  chk('unusable weather is named too', c.missing.some(x => /tournament-week profile/.test(x)));
  has(c.statement, 'tennis-baseline-1.0.0', 'the statement names the model version');
  has(c.statement, 'passes', 'and says whether the gates passed');

  /* a match that does NOT pass the gate */
  r = await T.retrieveTennis(fakeRpc({ ai_match_context: Object.assign({}, MATCH_ENTITLED, {
      prediction: Object.assign({}, MATCH_ENTITLED.prediction, { research_grade: 'provisional',
        exclusion_reasons: ['thin_rating_sample'] }) }), ai_data_health: HEALTH }),
    'why is EdgeDesk different from the market?', { match_ref: 'espn:1' });
  chk('a caveated match does not claim to pass the gates', r.contract.passes_research_gates === false);
  chk('and the gate reasons ride along', r.contract.gate_reasons.indexOf('thin_rating_sample') >= 0);
  has(r.contract.statement, 'does NOT pass', 'and the statement says so in words');

  /* INDOOR: weather does not apply, which is not the same as missing */
  r = await T.retrieveTennis(fakeRpc({ ai_match_context: Object.assign({}, MATCH_ENTITLED, {
      weather: { temporal_precision: 'indoor', usable: false, environment: 'indoor' } }), ai_data_health: HEALTH }),
    'is fatigue meaningful here?', { match_ref: 'espn:1' });
  chk('an indoor match says weather is not a factor',
      r.contract.missing.some(x => /not a factor \(indoor\)/.test(x)), JSON.stringify(r.contract.missing));

  /* NOT entitled: the database returns nothing, and that must be distinguishable */
  r = await T.retrieveTennis(fakeRpc({ ai_match_context: Object.assign({}, MATCH_ENTITLED,
      { entitled: false, prediction: null, market: null }), ai_data_health: HEALTH }),
    'what does the market price imply?', { match_ref: 'espn:1' });
  chk('an unentitled reader is recorded as unentitled', r.entitled === false);
  chk('and the contract says the price is a subscriber surface',
      r.contract.missing.some(x => /subscriber surface/.test(x)));
  r = await T.retrieveTennis(fakeRpc({ ai_market_disagreement: [], ai_data_health: HEALTH }),
    'where is the value against the market?', {});
  chk('an empty priced retrieval is flagged as possibly unentitled', r.maybe_unentitled === true);
  has(T.tennisPromptBlock(r), 'may not be entitled',
      'and the prompt tells the model to say so rather than imply EdgeDesk has nothing');

  /* A FAILED retrieval is a failure, never an empty result */
  r = await T.retrieveTennis(fakeRpc({ ai_data_health: HEALTH }, ['ai_surface_leaders']),
    'who is the strongest player on clay right now?', {});
  chk('a failed retrieval is recorded', r.failures.length === 1);
  chk('and named in the contract', r.contract.missing.some(x => /a retrieval failed/.test(x)));
  chk('and the evidence row says it was NOT substituted',
      r.evidence.some(e => e.failed && /NOT substituted/.test(e.note)));
  has(T.tennisPromptBlock(r), 'FAILED RETRIEVALS', 'and the prompt lists it');

  /* ── 4. THE RULES ARE ACTUALLY IN THE PROMPT ───────────────────────── */
  const block = T.tennisPromptBlock(await T.retrieveTennis(
    fakeRpc({ ai_match_context: MATCH_ENTITLED, ai_data_health: HEALTH }),
    'why is EdgeDesk different from the market?', { match_ref: 'espn:1' }));
  has(block, 'ANSWER CONTRACT', 'the prompt carries the answer contract');
  has(block, 'Do not compute, adjust, de-vig or recall one', 'the model is forbidden from computing a number');
  has(block, 'Never describe it as conditions at first serve', 'and from presenting week weather as match-time');
  has(block, 'Never invent an injury', 'and from inventing an injury');
  has(block, 'A doubles pair is a team', 'and from calling a pair a player');
  has(block, 'never a recommendation', 'and from turning a gap into a pick');
  has(block, 'An error is not an empty result', 'and from hiding a failure');
  chk('every rule reaches the prompt', T.TENNIS_RULES.every(x => block.indexOf(x) >= 0));
  chk('there are at least ten prohibitions', T.TENNIS_RULES.length >= 10);

  /* ── 5. THE CAPABILITY DECLARATION IS HONEST ───────────────────────── */
  const caps = T.TENNIS_CAPABILITIES.tennis_atp;
  eq('EdgeDesk has no tennis injury source, and says so', caps.tennis_injury, false);
  eq('no point-by-point', caps.tennis_point_by_point, false);
  eq('no doubles rating', caps.tennis_doubles, false);
  eq('no exact historical start time', caps.tennis_exact_start_time, false);
  eq('but it does have a rating layer', caps.tennis_rating, true);
  eq('and a model', caps.tennis_model, true);
  eq('ATP and WTA are the same module', T.TENNIS_CAPABILITIES.tennis_wta, T.TENNIS_CAPABILITIES.tennis_atp);
  has(T.TENNIS_NEEDS, 'a pair is a team', 'the needs line repeats the doubles rule');
  has(T.TENNIS_NEEDS, 'tournament week', 'and the tournament-week dating rule');

  /* ── 6. THE ENGINE REGISTRY AGREES WITH THIS FILE ──────────────────── */
  const LIB = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'functions', 'edgedesk_ai', '_lib.ts'), 'utf8');
  has(LIB, 'tennis_atp:', 'the sport registry knows about the ATP');
  has(LIB, 'tennis_wta:', 'and the WTA');
  chk('both are WIRED rather than core-only', () => {
    const seg = LIB.slice(LIB.indexOf('tennis_wta: {'), LIB.indexOf('tennis_wta: {') + 400);
    return /status: "WIRED"/.test(seg);
  });
  has(LIB, 'tennis_injury: false', 'and the capability matrix declares the injury gap');
  has(LIB, 'tennis_doubles: false', 'and the doubles gap');
  const IDX = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'functions', 'edgedesk_ai', 'index.ts'), 'utf8');
  has(IDX, '/*__EDTENNIS_START__*/', 'the deployed build carries the tennis layer');
  chk('and it is the same bytes as the canonical file', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'functions', 'edgedesk_ai', '_tennis.js'), 'utf8');
    const grab = (s) => s.slice(s.indexOf('/*__EDTENNIS_START__*/'), s.indexOf('/*__EDTENNIS_END__*/'));
    return grab(src) === grab(IDX);
  });

  /* ── 7. NO CREDENTIAL, NO COMPUTATION ──────────────────────────────── */
  const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'supabase', 'functions', 'edgedesk_ai', '_tennis.js'), 'utf8');
  ['SERVICE_ROLE', 'service_role', 'apikey', 'Bearer '].forEach(k =>
    chk('the tennis layer holds no credential: ' + k, SRC.indexOf(k) < 0));
  chk('and computes no probability of its own',
      SRC.indexOf('Math.exp') < 0 && SRC.indexOf('Math.pow') < 0);
  chk('it names only the five approved database calls', () => {
    const calls = [...new Set((SRC.match(/call\("(\w+)"/g) || []).map(x => x.replace(/call\("|"/g, '')))];
    return calls.length === 5 && calls.every(c => /^ai_/.test(c));
  });

  if (fail) {
    console.log('FAIL | tennis AI retrieval | ' + fail + ' of ' + (pass + fail) + ' assertions failed');
    failures.forEach(f => console.log('     | ' + f));
    process.exit(1);
  }
  console.log('PASS | tennis AI retrieval | ' + pass + ' assertions');
})();
