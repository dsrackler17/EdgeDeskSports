#!/usr/bin/env node
/* ============================================================================
   THE CONFIDENCE LEDGER CANNOT BE TALKED INTO A HIGHER NUMBER.

   The guarantees this file exists to hold, and each of them is a thing that
   would be easy to break by accident while making a card look better:

     1  STALE, CONFLICTING, FETCH_FAILED, UNAVAILABLE and NOT_DUE_YET data
        never counts as retrieved, never counts as verified, and never earns
        a point of confidence.
     2  INFERRED data is known and NOT verified — the two are different sets
        and the smaller one is the one a reader should trust.
     3  Every point between the displayed score and 100 is attributed to a
        named field. The ledger checks its own arithmetic and says so.
     4  A field that does not arise is excluded from the denominator and
        charged nothing; a field that is merely missing is charged in full.
     5  An outcome probability is never rendered as a certainty.
     6  The five published numbers have five different denominators and the
        module says which is which, rather than letting a reader assume they
        should agree.
   ========================================================================== */
'use strict';
const path = require('path');
const C = require(path.join(__dirname, 'confidence.js'));

let pass = 0, fail = 0;
function chk(what, cond, detail) {
  if (cond) { pass++; return; }
  fail++; console.error('  FAIL | ' + what + (detail === undefined ? '' : '  ' + JSON.stringify(detail)));
}
function section(t) { console.log('\n' + t); }

const W = { rating: 1, qb: 1, injuries: 0.35, weather: 0.1 };
const DEN = 2.45;
const M = (available, confidence, extra) => Object.assign({ available, confidence, value: available ? 1 : null,
  n: null, basis: 'test' }, extra || {});

function row(field, side, state, extra) {
  return Object.assign({ field, side: side || null, state, priced: state === 'USABLE',
    source: 'test', as_of: null, observed_at: null, age_hours: null, detail: null, fix: null }, extra || {});
}

/* ═════ 1. no state but USABLE and RESEARCH_ONLY is retrieved ══════════ */
section('1. what counts as retrieved, and what counts as verified');
const NEVER_KNOWN = ['STALE', 'CONFLICTING', 'FETCH_FAILED', 'UNAVAILABLE', 'NOT_DUE_YET'];
NEVER_KNOWN.forEach(st => {
  const m = C.meaningOf(st);
  chk(st + ' is never known', m.known === false, m);
  chk(st + ' is never verified', m.verified === false, m);
  chk(st + ' is never priced', m.priced === false, m);
  chk(st + ' costs points', m.costs_points === true, m);
});
chk('USABLE is known, verified and priced', (function () {
  const m = C.meaningOf('USABLE'); return m.known && m.verified && m.priced;
})());
chk('RESEARCH_ONLY is known and verified but NOT priced', (function () {
  const m = C.meaningOf('RESEARCH_ONLY'); return m.known && m.verified && !m.priced;
})());
/* THE ONE THE TASK NAMES EXPLICITLY: an inferred value is not a verified one */
chk('INFERRED is known and NOT verified — inference is never verified data', (function () {
  const m = C.meaningOf('INFERRED'); return m.known === true && m.verified === false;
})(), C.meaningOf('INFERRED'));
chk('and INFERRED still costs points, because the layer is not measured',
  C.meaningOf('INFERRED').costs_points === true);
chk('an unknown state defaults to NOT known and NOT verified', (function () {
  const m = C.meaningOf('SOMETHING_NEW'); return !m.known && !m.verified && m.costs_points;
})());
chk('NOT_APPLICABLE is the ONLY state excluded from the denominator, and it costs nothing',
  C.meaningOf('NOT_APPLICABLE').applicable === false && C.meaningOf('NOT_APPLICABLE').costs_points === false);
/* NOT_REQUIRED AND NOT_DUE_YET ARE REASONS, NOT EXCUSES. "No conference
   filing was required for this fixture" and "the first filing is still hours
   away" are both true, both precise, and neither is a statement that EdgeDesk
   knows who can play. The engine charges for that ignorance, so the contract
   counts it — otherwise "nobody had to file" quietly becomes "nothing is
   missing", which is the exact substitution this whole layer exists to stop. */
['NOT_REQUIRED', 'NOT_DUE_YET'].forEach(st => {
  const m = C.meaningOf(st);
  chk(st + ' stays in the denominator', m.applicable !== false, m);
  chk(st + ' is not known, not verified, and costs points',
    m.known === false && m.verified === false && m.costs_points === true, m);
});

/* ═════ 2. the ledger's arithmetic ════════════════════════════════════ */
section('2. every lost point lands on exactly one named field');
{
  const contract = [
    row('roster', 'home', 'USABLE'), row('roster', 'away', 'USABLE'),
    row('qb_starter', 'home', 'RESEARCH_ONLY'), row('qb_starter', 'away', 'RESEARCH_ONLY'),
    row('qb_availability', 'home', 'UNAVAILABLE'), row('qb_availability', 'away', 'UNAVAILABLE'),
    row('availability', 'home', 'FETCH_FAILED'), row('availability', 'away', 'FETCH_FAILED'),
    row('weather', null, 'NOT_APPLICABLE')
  ];
  const info = { rating: M(true, 1), qb: M(true, 0.5), injuries: M(true, 0.5), weather: M(false, 0) };
  const L = C.ledger({ contract, information: info, weights: W, weight_total: DEN,
    summary: { fields: 9, applicable: 8, known: 4, input_coverage: 0.5, priced_coverage: 0.25,
      by_state: {}, priced: 2 },
    confidence: 100 * (1 * 1 + 1 * 0.5 + 0.35 * 0.5 + 0) / DEN,
    confidence_priced: 30, engine_completeness: 0.6, home_win_prob: 0.5, home: 'H', away: 'A' });

  chk('the ledger reconciles to 100', L.reconciles.agrees === true, L.reconciles);
  /* THE FIXTURE DELIBERATELY DISAGREES WITH ITSELF: the contract calls
     weather inapplicable and the engine scores it unmeasured and charges for
     it. That is exactly the "these two numbers are supposed to describe the
     same game" case, and the ledger must NAME it rather than absorb the
     points into a rounding. */
  chk('an input charged while its contract fields are inapplicable is reported as a disagreement',
    L.disagreements.length === 1 && L.disagreements[0].input === 'weather', L.disagreements);
  chk('and the disagreement says what each side claims',
    /inapplicable/.test(L.disagreements[0].contract_says) && /unmeasured/.test(L.disagreements[0].engine_says),
    L.disagreements[0]);
  chk('the unattributed residue equals exactly that disagreement, and nothing else',
    Math.abs(L.reconciles.points_lost_not_attributable_to_a_contract_field - L.disagreements[0].lost_points) < 0.01,
    L.reconciles);
  chk('attributed plus disagreement equals the total',
    Math.abs((L.reconciles.points_lost_attributed_to_fields
      + L.reconciles.points_lost_not_attributable_to_a_contract_field) - L.reconciles.points_lost_total) < 0.05,
    L.reconciles);

  const by = {};
  L.fields.forEach(f => { by[f.field + ':' + (f.side || '-')] = f; });
  chk('a NOT_APPLICABLE field is charged nothing', by['weather:-'].lost_points === 0, by['weather:-']);
  chk('and is marked inapplicable', by['weather:-'].applicable === false, by['weather:-']);
  chk('the FETCH_FAILED availability rows carry the injury loss',
    by['availability:home'].lost_points > 0 && by['availability:away'].lost_points > 0,
    [by['availability:home'].lost_points, by['availability:away'].lost_points]);
  chk('a RESEARCH_ONLY field is known but not priced',
    by['qb_starter:home'].known === true && by['qb_starter:home'].affects_pricing === false);
  chk('a well-formed ledger has no disagreements at all', (function () {
    const clean = C.ledger({
      contract: [row('roster', 'home', 'USABLE'), row('roster', 'away', 'USABLE')],
      information: { roster_home: M(true, 1), roster_away: M(true, 1) },
      weights: { roster_home: 0.25, roster_away: 0.25 }, weight_total: 0.5,
      summary: { fields: 2, applicable: 2, known: 2, input_coverage: 1, priced_coverage: 1, by_state: {}, priced: 2 },
      confidence: 100, confidence_priced: 100, home: 'H', away: 'A' });
    return clean.disagreements.length === 0 && clean.reconciles.agrees === true;
  })());
  chk('every field names the engine input it feeds',
    L.fields.every(f => Array.isArray(f.feeds_inputs)), L.fields.map(f => f.field));
  chk('and a field that feeds nothing scored says so rather than looking like a hole',
    L.fields.filter(f => !f.feeds_inputs.length).every(f => f.scored === false && !!f.note));
}

/* ═════ 3. a missing field is charged in full ═════════════════════════ */
section('3. missing is charged in full; retrieved-but-thin is charged for what is thin');
{
  const full = C.ledger({
    contract: [row('weather', null, 'UNAVAILABLE')],
    information: { weather: M(false, 0) }, weights: { weather: 0.1 }, weight_total: 0.1,
    summary: { fields: 1, applicable: 1, known: 0, input_coverage: 0, priced_coverage: 0, by_state: {}, priced: 0 },
    confidence: 0, confidence_priced: 0, home: 'H', away: 'A' });
  chk('an UNAVAILABLE field costs the whole weight', Math.abs(full.fields[0].lost_points - 100) < 0.01,
    full.fields[0].lost_points);

  const thin = C.ledger({
    contract: [row('weather', null, 'USABLE')],
    information: { weather: M(true, 0.6) }, weights: { weather: 0.1 }, weight_total: 0.1,
    summary: { fields: 1, applicable: 1, known: 1, input_coverage: 1, priced_coverage: 1, by_state: {}, priced: 1 },
    confidence: 60, confidence_priced: 60, home: 'H', away: 'A' });
  chk('a retrieved field whose layer is only partly measured still carries that cost',
    Math.abs(thin.fields[0].lost_points - 40) < 0.01, thin.fields[0].lost_points);
  chk('and says the gap is inside the field rather than looking like a bug',
    /partly measured/.test(thin.fields[0].why_costing || ''), thin.fields[0].why_costing);
}

/* ═════ 4. the five numbers are five questions ════════════════════════ */
section('4. five numbers, five denominators, each named');
{
  const s = C.scoreboard({ confidence: 73, confidence_priced: 48, engine_completeness: 0.6,
    summary: { input_coverage: 0.647, priced_coverage: 0.41, known: 11, applicable: 17, fields: 19 },
    home_win_prob: 0.9977, weight_total: 4.083 });
  chk('information confidence is published as evidence quality',
    /EVIDENCE QUALITY/.test(s.information_confidence.measures), s.information_confidence.measures);
  chk('priced confidence is published as validated pricing coverage',
    /VALIDATED PRICING COVERAGE/.test(s.priced_confidence.measures));
  chk('input coverage says it is a COUNT, not a weighted score',
    /COUNT/.test(s.input_coverage.measures) && /weighted confidence/i.test(s.input_coverage.not_the_same_as),
    { measures: s.input_coverage.measures, not: s.input_coverage.not_the_same_as });
  chk('and it reports 11 of 17 as the count it is',
    s.input_coverage.known === 11 && s.input_coverage.applicable === 17, s.input_coverage);
  chk('the engine probe count says it is a diagnostic of the engine, not of the data',
    /diagnostic of the engine/.test(s.engine_probe_completeness.measures));
  chk('the outcome probability says it is not a confidence',
    /not a confidence/.test(s.outcome_probability.measures));
  chk('every entry says what it is NOT',
    ['information_confidence', 'priced_confidence', 'input_coverage', 'engine_probe_completeness',
      'outcome_probability'].every(k => !!s[k].not_the_same_as));
  chk('and the module explains why they differ instead of leaving it to the reader',
    /different questions|five denominators|different denominators/i.test(s.why_they_differ), s.why_they_differ);
}

/* ═════ 5. a probability is never a certainty ═════════════════════════ */
section('5. 100% and 0% are never printed for an interior probability');
{
  chk('0.9977 renders as >99%, not 100%', C.outcomeLabel(0.9977).text === '>99%', C.outcomeLabel(0.9977));
  chk('0.0023 renders as <1%, not 0%', C.outcomeLabel(0.0023).text === '<1%', C.outcomeLabel(0.0023));
  chk('and neither claims certainty',
    C.outcomeLabel(0.9977).certain === false && C.outcomeLabel(0.0023).certain === false);
  chk('a genuine 1 is allowed to say 100% — and this engine never produces one',
    C.outcomeLabel(1).text === '100%' && C.outcomeLabel(1).certain === true);
  chk('an ordinary probability is untouched', C.outcomeLabel(0.63).text === '63%');
  const pair = C.outcomePair(0.9977);
  chk('the pair stays complementary: a bounded favourite has a bounded underdog',
    pair.home.text === '>99%' && pair.away.text === '<1%', pair);
  chk('and the pair says why it is bounded', /cannot mean 100% or 0%/.test(pair.note || ''), pair.note);
  /* the exact reproduction case */
  chk('Oregon at 0.998 does not print 100%/0%',
    C.outcomePair(0.998).home.text !== '100%' && C.outcomePair(0.998).away.text !== '0%');
}

/* ═════ 6. the field map is complete ═════════════════════════════════ */
section('6. every contract field the assembly publishes has a meaning and a mapping');
{
  const IN = require(path.join(__dirname, 'inputs.js'));
  chk('the module maps every field name it knows to an input list',
    Object.keys(C.FIELD_TO_INPUT).every(f => !!C.FIELD_META[f]),
    Object.keys(C.FIELD_TO_INPUT).filter(f => !C.FIELD_META[f]));
  chk('and every mapped field publishes its meaning and its units',
    Object.keys(C.FIELD_META).every(f => !!C.FIELD_META[f].means && !!C.FIELD_META[f].unit),
    Object.keys(C.FIELD_META).filter(f => !C.FIELD_META[f].means || !C.FIELD_META[f].unit));
  chk('the assembly is loadable, so the two files agree about what a contract row looks like',
    typeof IN.buildRequest === 'function');
}

console.log('\nconfidence ledger: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
