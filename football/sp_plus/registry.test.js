#!/usr/bin/env node
/* ============================================================================
   SP+ IS AN EXTERNAL ESTIMATE, AND STAYS ONE.

   The registry (football/sp_plus/registry.json) names it external; this file
   holds the repository to that:
   - it is never a Model Lab role, a champion, a candidate for promotion or a
     compatibility entry;
   - no EdgeDesk model, EV, ranking, grade, record, decision or Lab code reads
     its module or its file;
   - on the page it is read in exactly three places (the board card, the game
     page's hook, the football loader), and no registry row can badge it
     Validated.

   Run: node football/sp_plus/registry.test.js
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const SP = require('../../lib/cfb_sp_plus.js');

const ROOT = path.join(__dirname, '..', '..');
let pass = 0, fail = 0;
function ok(cond, name, detail) {
  if (cond) { pass++; return; }
  fail++; console.log('FAIL | ' + name + (detail === undefined ? '' : '  ' + JSON.stringify(detail).slice(0, 500)));
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name, { got: a, want: b }); }
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* ------------------------------------------------------------- the registry */
const REG = JSON.parse(read('football/sp_plus/registry.json'));
const E = REG.estimates.find((x) => x.id === 'cfbd.sp_plus_projected_line');
ok(!!E, 'registry: SP+ projected line is registered');
eq([E.kind, E.edgedesk_model, E.validated_by_edgedesk], ['EXTERNAL_ESTIMATE', false, false], 'registry: an external estimate, not an EdgeDesk model, not validated by EdgeDesk');
eq([E.provenance.rating.tier, E.provenance.line.tier, E.provenance.line.rule], ['T3', 'T2', SP.RULE], 'registry: T3 rating, T2 line, the projection rule in lib/cfb_sp_plus.js');
eq(E.attribution, SP.ATTRIBUTION, 'registry: the attribution is the one every card prints');
ok(/collegefootballdata\.com\/terms/.test(E.terms.provider_terms_url) && E.terms.provider_terms_dated === '2026-08-12' && /ESPN/.test(E.terms.rating_owner) && /derived projected line only/.test(E.terms.display_decision),
  'registry: the terms are recorded, with the date read, SP+’s owner and the display decision');
ok(/cfbd-ratings-sp/.test(E.source.version) && /ratings\/sp/.test(E.source.endpoint), 'registry: source and version recorded');
const LINES = JSON.parse(read('football/sp_plus/lines.json'));
eq([LINES.provenance.external, LINES.provenance.edgedesk_model, LINES.provenance.validated_by_edgedesk, LINES.provenance.registry],
  [true, false, false, 'football/sp_plus/registry.json'], 'lines.json: carries the same provenance and points at the registry');
const SQL = read('supabase/cfb_sp_plus.sql');
ok(/'cfbd\.sp_plus_projected_line', 'SP\+ projected line', 'EXTERNAL_ESTIMATE'/.test(SQL) && /check \(edgedesk_model = false and validated_by_edgedesk = false\)/.test(SQL),
  'the database registry mirrors it, and refuses to mark it an EdgeDesk model or validated');

/* --------------------------------------------- never a Model Lab participant */
const roles = read('football/cfb_lab/governance/model_roles.jsonl');
ok(!/sp_plus|spplus|sp\+/i.test(roles), 'Model Lab: no role (champion, challenger, candidate) is SP+');
const compat = read('football/cfb_production/compatibility.json');
ok(!/sp_plus|spplus/i.test(compat), 'production: no compatibility entry for SP+');
for (const f of ['football/cfb_production/reports/champion.json', 'football/cfb_lab/reports/2026/promotion.json']) {
  if (fs.existsSync(path.join(ROOT, f))) ok(!/sp_plus|cfbd\.sp/i.test(read(f)), f + ': no SP+');
}

/* ------------------------------------- never read by the model, EV or grades */
const GUARDED = ['football/cfb_p4', 'football/cfb_v2', 'football/cfb_ev', 'football/cfb_lab', 'football/cfb_production', 'football/cfb_decision',
  'football/cfb_market', 'football/rankings', 'football/rating', 'football/fbs', 'model_loop', 'tools/record', 'record'];
const files = execFileSync('git', ['ls-files', '-z', '--', ...GUARDED], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 }).split('\0')
  .filter((f) => /\.(js|py|ts|sql|json|jsonl)$/.test(f) && !/\/(ledger|snapshots|candidates|history|artifacts)\//.test(f));
const libs = execFileSync('git', ['ls-files', '-z', '--', 'lib'], { cwd: ROOT, encoding: 'utf8' }).split('\0')
  .filter((f) => /^lib\/(edgedesk_ev|edgedesk_quote_ev|edgedesk_decision|cfb_champion|cfb_disagreement|edgedesk_canon|edgedesk_research_engine)/.test(f));
const hits = files.concat(libs).filter((f) => /football\/sp_plus|cfb_sp_plus|EDCfbSpPlus|cfb_sp_ratings/.test(read(f)));
ok(files.length > 200, 'the guarded code was found (' + files.length + ' files)');
eq(hits, [], 'no EdgeDesk model, EV, ranking, grade, record, decision or Lab file reads SP+');

/* ------------------------------------ on the page: three places, never Validated */
const APP = read('app.html');
const fnRange = (name) => { const a = APP.indexOf('function ' + name + '('); const b = APP.indexOf('\nfunction ', a + 10); return [a, b < 0 ? APP.length : b]; };
const gx = fnRange('fbGxSummary');
const gvA = APP.indexOf('  function gvOpts(){return {'), gvB = APP.indexOf('\n  }', gvA);
const loader = APP.indexOf('.then(function(){return window.EDCfbSpPlus?window.EDCfbSpPlus.fetchLines(window.EDCfbSpPlus.URL)');
const uses = [];
for (let i = APP.indexOf('EDCfbSpPlus'); i >= 0; i = APP.indexOf('EDCfbSpPlus', i + 1)) uses.push(i);
const where = uses.map((i) => (i >= gx[0] && i < gx[1] ? 'board card' : (i > gvA && i < gvB ? 'game page hook' : (i >= loader && i < loader + 200 ? 'football loader' : 'ELSEWHERE:' + APP.slice(0, i).split('\n').length))));
ok(loader > 0 && gx[0] > 0 && gvA > 0, 'the three places exist');
eq(where.filter((w) => /^ELSEWHERE/.test(w)), [], 'app.html reads SP+ only on the board card, the game page hook and the football loader');
ok(APP.indexOf('/lib/cfb_sp_plus.js?v=') > 0, 'app.html loads the module');

/* rsMaturity, run as the page runs it, with a registry row that claims Validated */
{
  const a = APP.indexOf('var RS_MODELS='), b = APP.indexOf('function rsBadgeHTML(');
  const ctx = { sbGet: () => Promise.resolve([]), Date };
  vm.createContext(ctx);
  vm.runInContext(APP.slice(a, b), ctx);
  ctx.RS_MODELS.state = 'ok';
  ctx.RS_MODELS.rows = [{ model_key: 'cfbd.sp_plus', status: 'validated' }, { model_key: 'edgedesk.some_model', status: 'validated' }];
  const m = vm.runInContext("rsMaturity('cfbd.sp_plus')", ctx);
  eq([m.label, m.cls, m.hasReport], ['External', 'rs-mat-ext', false], 'a registry row claiming SP+ is Validated still badges it External');
  eq(vm.runInContext("rsMaturity('CFBD.SP_PLUS').label", ctx), 'External', 'whatever the key’s case');
  eq(vm.runInContext("rsMaturity('edgedesk.some_model').label", ctx), 'Validated', 'an EdgeDesk model still reads its own registry row');
}
ok(/\{nm:'SP\+ rating, ranking, SOS',tier:'T3',model:'cfbd\.sp_plus',src:'[^']*External: never an EdgeDesk model/.test(APP), 'the provenance table calls the SP+ rating external');
ok(/\{nm:'SP\+ projected line on CFB cards',tier:'T2',src:/.test(APP), 'and lists the projected line as T2 computed');

console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
