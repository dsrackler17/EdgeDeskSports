#!/usr/bin/env node
/* ===========================================================================
   THE RESEARCH BENCHMARK, IN CI — tools/research/benchmark (≥ 100 questions in
   10 categories through the real handler, recorded responses only).

   It asserts invariants, not tuned scores:
     - at least 100 questions, 10 categories, at least 10 in each
     - every item meets its expectations, except a documented KNOWN GAP — and a
       known gap must still reproduce (a fixed one is removed from the list)
     - no link the subscriber sees was invented; no refused citation was used
     - every engine answer is VERIFIED: no calculation mismatch, no number in an
       answer without the calculation behind it
     - no certainty word, no invented price, no actionable verdict the
       evidence forbids
     - no odds request, no live provider call (recorded responses only)
     - local latency stays within a generous bound (a regression guard, not a
       production figure)

   Run: node --experimental-strip-types --no-warnings tools/intelligence/benchmark.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const B = require(path.join(ROOT, 'tools', 'research', 'benchmark', 'run.js'));
const { Q } = require(path.join(ROOT, 'tools', 'research', 'benchmark', 'questions.js'));
let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) { pass++; return; } fail++; console.log('FAIL | ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 900) : '')); }

(async () => {
  /* the question set itself */
  const cats = {};
  Q.forEach((x) => { cats[x.cat] = (cats[x.cat] || 0) + 1; });
  ok('at least 100 questions', Q.length >= 100, Q.length);
  ok('10 categories, at least 10 questions in each', Object.keys(cats).length === 10 && Object.values(cats).every((n) => n >= 10), cats);
  ok('every item names its route', Q.every((x) => typeof x.route === 'string' && x.route.length > 0), Q.filter((x) => !x.route).map((x) => x.id));
  ok('item ids are unique', new Set(Q.map((x) => x.id)).size === Q.length);

  const res = await B.run({});
  const s = res.summary;
  ok('recorded responses only', res.recorded_responses === true);
  ok('every item ran', s.questions === Q.length, s.questions);
  ok('no unexpected failure (every failure is a documented known gap)', s.unexpected_failures.length === 0, s.failures.filter((f) => !f.known_gap));
  ok('every known gap still reproduces (a fixed gap is removed from questions.js and REPORT.md)', s.known_gaps.every((g) => g.reproduced), s.known_gaps.filter((g) => !g.reproduced));
  ok('routing: every item that is not a known gap reached its route', res.rows.filter((r) => !r.known_gap).every((r) => r.route_ok), res.rows.filter((r) => !r.known_gap && !r.route_ok).map((r) => [r.id, r.route, r.expected_route]));

  /* citations */
  ok('citations: links were checked', s.citations.links_seen > 0, s.citations);
  ok('citations: no invented link (every link was served to the handler, or is a documented provenance link)', s.citations.invented === 0, res.rows.filter((r) => r.invented_urls.length).map((r) => [r.id, r.invented_urls]));
  ok('citations: no refused search citation reached an answer', s.citations.refused_used === 0);

  /* quantitative correctness */
  ok('quantitative: engine answers carry their verification', s.quantitative.answers_with_verification >= 40, s.quantitative);
  ok('quantitative: every engine answer is VERIFIED', s.quantitative.verified === s.quantitative.answers_with_verification, res.rows.filter((r) => r.quant && r.quant.verdict !== 'VERIFIED').map((r) => [r.id, r.quant]));
  ok('quantitative: no calculation record disagrees with its recomputation', s.quantitative.calc_mismatches === 0 && s.quantitative.calc_records_checked > 0, s.quantitative);
  ok('quantitative: every number in every engine answer traces to a calculation', s.quantitative.numbers_unsupported === 0 && s.quantitative.numbers_pass === s.quantitative.answers_with_verification, s.quantitative);

  /* unsupported claims */
  ok('unsupported: no certainty word in any answer', s.unsupported_claims.certainty_words === 0, res.rows.filter((r) => r.certainty).map((r) => r.id));
  ok('unsupported: no price invented where none was captured', s.unsupported_claims.invented_prices === 0, res.rows.filter((r) => r.invented_price).map((r) => r.id));
  ok('unsupported: no actionable verdict the evidence forbids', s.unsupported_claims.actionable_against_expectation === 0);

  /* safety of the run itself */
  ok('no odds request in any item', res.rows.every((r) => !r.failed.some((c) => c.name === 'no odds request')));
  ok('search ran only where the item switched it on, against the recorded fixture', res.rows.every((r) => r.search_calls === 0 || Q.find((x) => x.id === r.id).env === 'search'), res.rows.filter((r) => r.search_calls).map((r) => r.id));
  ok('the UNSUPPORTED path never calls the model', res.rows.filter((r) => r.route === 'UNSUPPORTED').every((r) => r.model_calls === 0), res.rows.filter((r) => r.route === 'UNSUPPORTED' && r.model_calls).map((r) => r.id));
  ok('the AVAILABILITY path never calls the model', res.rows.filter((r) => r.route === 'AVAILABILITY').every((r) => r.model_calls === 0 && r.search_calls === 0), res.rows.filter((r) => r.route === 'AVAILABILITY' && (r.model_calls || r.search_calls)).map((r) => r.id));
  ok('latency: local p95 within 3 s (a regression guard on the fixture network)', s.latency_ms.p95 != null && s.latency_ms.p95 < 3000, s.latency_ms);

  console.log((fail ? 'FAILED ' : 'ALL GREEN ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
