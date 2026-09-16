#!/usr/bin/env node
/* ===========================================================================
   THE POSTMORTEM separates data failures, analytical errors, model errors
   and variance, and turns repeats into candidates that still have to earn
   a held-out evaluation. Synthetic graded rows, labelled as such.

   Run: node tools/intelligence/postmortem.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const P = require(path.join(__dirname, 'postmortem.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + String(JSON.stringify(f.detail)).slice(0, 300)));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
const CFB = 'americanfootball_ncaaf';
function row(o) {
  return Object.assign({ packet_id: 'p' + Math.random().toString(36).slice(2, 8), sport: CFB, game_id: 'g', side: 'home', selection: 'Home U', label: 'RESEARCH LEAD', outcome: 'LOSS', model_home_line: -7, closing_home_line: -7, final_home_margin: -3,
    packet: { game: { home: 'Home U', away: 'Away U' }, confidence: { data: { missing: [] } }, analysis_summary: { decisive: ['pass_rush_vs_protection:Home U'] } } }, o);
}

/* ---- classes ------------------------------------------------------------ */
chk('a covered side is a HIT', P.classify(row({ outcome: 'WIN' })).class === 'HIT');
chk('a push is a PUSH', P.classify(row({ outcome: 'PUSH' })).class === 'PUSH');
chk('no final margin is UNGRADED', P.classify(row({ final_home_margin: null, outcome: '' })).class === 'UNGRADED');
const dataMiss = P.classify(row({ packet: { game: { home: 'Home U', away: 'Away U' }, confidence: { data: { missing: ['availability for both sides', 'projected starters on both sides', 'weather'] } }, analysis_summary: null } }));
chk('a miss built without the inputs is a DATA_FAILURE', dataMiss.class === 'DATA_FAILURE' && /availability/.test(dataMiss.why), dataMiss);
chk('an INSUFFICIENT DATA label is a DATA_FAILURE', P.classify(row({ label: 'INSUFFICIENT DATA' })).class === 'DATA_FAILURE');
const variance = P.classify(row({ final_home_margin: -3 }));
chk('a miss inside one sigma with the read pointing the right way is VARIANCE', variance.class === 'VARIANCE' && /inside the model/.test(variance.why), variance);
const analytical = P.classify(row({ model_home_line: -2, closing_home_line: -2, final_home_margin: -9, packet: { game: { home: 'Home U', away: 'Away U' }, confidence: { data: { missing: [] } }, analysis_summary: { decisive: ['explosive_pass_vs_coverage:Home U'] } } }));
chk('a read that pointed the wrong way by a touchdown or more, with the number close, is an ANALYTICAL_ERROR', analytical.class === 'ANALYTICAL_ERROR' && /explosive_pass_vs_coverage/.test(analytical.why), analytical);
const model = P.classify(row({ model_home_line: -14, closing_home_line: -3, final_home_margin: -6 }));
chk('a projection that missed where the close did not is a MODEL_ERROR', model.class === 'MODEL_ERROR' && /the market had it/.test(model.why), model);
const outlier = P.classify(row({ model_home_line: -7, closing_home_line: -7, final_home_margin: -30 }));
chk('a miss beyond sigma the close also missed is VARIANCE, not a diagnosed error', outlier.class === 'VARIANCE' && /outlier/.test(outlier.why), outlier);
chk('the residual is stated from the projection', variance.residual === -10 && P.classify(row({ final_home_margin: 10 })).residual === 3);
chk('the favourite bucket is stated', P.classify(row({ model_home_line: -10 })).favourite_bucket === '7-14');
chk('closing-line value in points rides on the classification when a quoted line and a close exist', P.classify(row({ handicap: -5.5, closing_home_line: -7 })).clv_points === 1.5 && P.classify(row({ side: 'away', selection: 'Away U', handicap: 6.5, closing_home_line: -7 })).clv_points === -0.5 && P.classify(row({})).clv_points === null);

/* ---- aggregation and candidates ---------------------------------------- */
const rows = [];
for (let i = 0; i < 12; i++) rows.push(row({ outcome: i < 9 ? 'LOSS' : 'WIN', model_home_line: -10, closing_home_line: -3, final_home_margin: i < 9 ? -2 : 12, packet: { game: { home: 'Home U', away: 'Away U' }, confidence: { data: { missing: [] } }, analysis_summary: { decisive: ['rushing_vs_front:Home U'] } } }));
for (let i = 0; i < 12; i++) rows.push(row({ outcome: i < 5 ? 'LOSS' : 'WIN', model_home_line: -2, closing_home_line: -2, final_home_margin: i < 5 ? -1 : 6, packet: { game: { home: 'Home U', away: 'Away U' }, confidence: { data: { missing: [] } }, analysis_summary: { decisive: ['special_teams_field_position:Home U'] } } }));
const rep = P.report(rows);
chk('counts reconcile', rep.counts.graded === 24 && rep.counts.hits === 10 && rep.counts.misses === 14, rep.counts);
chk('misses are grouped by class', rep.groups.by_class.MODEL_ERROR >= 9, rep.groups.by_class);
chk('a repeated model error in the 7-14 favourite bucket becomes a candidate', rep.candidates.some((c) => c.dominant_class === 'MODEL_ERROR' && /7-14/.test(c.key)), rep.candidates);
chk('the candidate is a HYPOTHESIS that names the held-out evaluation', rep.candidates.every((c) => c.status === 'HYPOTHESIS' && /held-out/.test(c.evaluation_required) && /reviewed/.test(c.evaluation_required)));
chk('the pick-3 bucket, at the base rate, produces no candidate', !rep.candidates.some((c) => /pick-3/.test(c.key)), rep.candidates.map((c) => c.key));
const few = P.report(rows.slice(0, 5));
chk('below the sample floor nothing is proposed', few.candidates.length === 0, few.candidates);
chk('the report says one loss proves nothing', /One loss is not proof/.test(rep.note) && /nothing generated here becomes a verified fact/.test(rep.note));
done();
