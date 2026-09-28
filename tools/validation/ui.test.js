#!/usr/bin/env node
/* ===========================================================================
   The pages read the canon (lib/edgedesk_canon.js) — and nothing drifts back.

     1  the app: the two rating names, the explainer, the canonical counter
        hierarchy, one research status per game (the research page's), a
        separate decision cell, "What prices this game?", the market
        independence statement, and a gate that counts only dated books;
     2  the research terminal: the canon loaded first, research vs decision
        chips, the six questions, the pricing panel, the audit packet, the
        cleanest / high-uncertainty / maturity routes, and no claim that an
        unpriced layer prices the game;
     3  the landing: no retired synonym (REVIEW, THIN DATA) and no claim that
        contradicts a threshold;
     4  the internal validation dashboard: its own render code, run on the
        committed artifacts, prints every section with no NaN or undefined.

   Run: node tools/validation/ui.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 300); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function has(h, s, name) { chk(name, String(h).indexOf(s) >= 0, 'missing: ' + s); }
function lacks(h, s, name) { chk(name, String(h).indexOf(s) < 0, 'present: ' + s); }

/* 1. the app */
const APP = read('app.html');
has(APP, '<script src="/lib/edgedesk_canon.js', 'the app loads the canon');
chk('the canon loads before the board code runs', APP.indexOf('/lib/edgedesk_canon.js') < APP.indexOf('function fbP4Ratings'));
lacks(APP, 'EdgeDesk FBS Rating —', 'the retired rating name is gone from the ratings section');
lacks(APP, 'Engine state · diagnostic', 'the retired engine-state label is gone');
has(APP, 'Current FBS Power Rating — top 25', 'the current rating is named CURRENT FBS POWER RATING');
has(APP, 'Production Pricing State <span', 'the engine state is named PRODUCTION PRICING STATE');
has(APP, 'function fbTwoRatingsExplainer', 'one explainer between the two numbers');
has(APP, 'which one prices', 'the explainer says which one prices');
has(APP, 'function fbRatingPairHTML', 'every team shows both numbers, the difference and why');
has(APP, 'C.ratingPair(', 'the explanation comes from the canon, built from the engine structure');
has(APP, 'strength.blendedRating(S.state', 'the pricing state shown is the engine’s own priced blend');
has(APP, "{n:H.all,l:'All games'},{n:H.ready,l:'Research ready'", 'the counters are the canonical hierarchy');
lacks(APP, "l:'Market disagreements'", 'the redundant Market disagreements counter is merged away');
has(APP, 'function fbCanonCountersHTML', 'per-sport ready counts and CFB statuses sit under the hierarchy');
has(APP, 'football/cfb_terminal/board.json', 'the app reads the canonical research statuses');
has(APP, 'function fbCanonApply', 'and shows them, so a game has one status everywhere');
has(APP, "out+=cell('Decision'", 'the decision has its own cell, apart from the research status');
has(APP, "fbGxSec(gid,'pricing','What prices this game?'", 'every CFB game says what prices it');
has(APP, 'C.INDEPENDENCE.text', 'with the market-independence statement');
chk('the gate counts only dated, fresh quotes as books', (function () {
  const a = APP.indexOf('function fbP4DisagreementFor'), b = APP.indexOf('function fbP4UnitFor', a);
  const src = APP.slice(a, b);
  return /q\.actionable===true/.test(src) && /q\.captured_at/.test(src) && /books:consG&&consG\.books_reporting\?consG\.books_reporting:0/.test(src);
})());
has(APP, 'Research only · PRICING IMPACT: NO.', 'player quality says PRICING IMPACT: NO');
lacks(APP, "badges.push(['blue','Walk-forward tracked'])", 'a historical backtest is never called walk-forward tracked');
has(APP, 'C.BADGE_RULES.WALK_FORWARD_TRACKED', 'the model card awards badges under the canon’s rules');
lacks(APP, "label:'Review',cls:'warn'", 'the retired REVIEW synonym is not displayed');

/* 2. the research terminal */
const IDX = read('research/cfb/index.html'), TJS = read('research/cfb/terminal.js');
chk('the terminal loads the canon before the terminal library', IDX.indexOf('/lib/edgedesk_canon.js') > 0 && IDX.indexOf('/lib/edgedesk_canon.js') < IDX.indexOf('/lib/cfb_terminal.js'));
['#/cleanest', '#/uncertain', '#/maturity'].forEach((r) => has(IDX, 'href="' + r + '"', 'the terminal links ' + r));
['function rsChip', 'function dsChip', 'function sixAnswers', 'function pricingPanel', 'function packetHTML', 'function renderLens', 'function renderMaturity', 'function countersHTML']
  .forEach((f) => has(TJS, f, 'the terminal has ' + f));
has(TJS, 'CURRENT MODEL RECORD', 'the record shows the current model record');
has(TJS, 'LEGACY — MODEL LAB RECONSTRUCTION', 'beside the legacy record, never blended');
has(TJS, 'Frozen pre-KO', 'the record says what was frozen before kickoff');
has(TJS, 'Status then', 'and the status at prediction time');
lacks(TJS, 'home field, quarterback, matchup, travel, rest. The market never enters', 'the Why page no longer claims travel prices the game');
has(TJS, 'Travel, rivalry, weather, player quality and the current power rating are shown, not priced', 'and says what is shown, not priced');
chk('one canonical disclaimer in the footer', (IDX.match(/research tool/g) || []).length === 1);

/* 3. the landing */
const LAND = read('index.html');
lacks(LAND, "state:'REVIEW'", 'the landing demo drops the REVIEW synonym');
lacks(LAND, 'past EdgeDesk&rsquo;s own guard bound', 'and no longer calls a 10.5-pt gap past the 21-pt guard');
has(LAND, "state:'WORTH RESEARCHING'", 'the small-gap demo is WORTH RESEARCHING');

/* 4. the validation dashboard runs its own code on the committed artifacts */
const VAL = read('admin/cfb-validation/index.html');
const a = VAL.indexOf('/*__EDVAL_START__*/'), b = VAL.indexOf('/*__EDVAL_END__*/');
chk('the dashboard carries its pure render block', a > 0 && b > a);
const ctx = { window: {}, module: { exports: {} } };
vm.createContext(ctx);
vm.runInContext(VAL.slice(a, b), ctx);
const E = ctx.window.EDVAL;
const J = (f) => JSON.parse(read('football/cfb_validation/' + f));
const html = E.render({ live: J('live.json'), signals: J('signals.json'), divergence: J('divergence.json'), postmortems: J('postmortems.json'),
  audit: J('slate_audit.json'), changes: J('changes.json'), maturity: J('maturity.json') });
E.SECTIONS.forEach((s) => has(html, 'id="' + s[0] + '"', 'the dashboard renders ' + s[1]));
has(html, 'SINCE CURRENT MODEL VERSION', 'the since-upgrade view is a named column');
has(html, 'LEGACY (RECONSTRUCTED)', 'the legacy view is its own column');
['FOOTBALL MODEL', 'MARKET INTELLIGENCE', 'BETTING DECISIONS'].forEach((s) => has(html, s, 'the dashboard keeps ' + s + ' apart'));
lacks(html, '&lt;span', 'no escaped markup reaches a heading');
lacks(html, '&amp;amp;', 'nothing is escaped twice');
lacks(html, 'NaN', 'no NaN reaches the page');
lacks(html, 'undefined', 'no undefined reaches the page');
chk('a missing artifact says so rather than rendering empty success', /did not load/.test(E.render({})));

/* 4b. one decision per game on the research page: the Read card's decision
   line is the canonical decision, the word the DECISION chip prints */
has(TJS, "Decision: <b>' + esc(readDecisionLabel(o, R))", 'the Read card prints the canonical decision');
lacks(TJS, "Decision: <b>' + esc(R.decision_status", 'and never the Read’s own stored decision beside it');

/* 5. the Collective: the canonical CSV tail rides at the end of both exports
   and the Collective maps a column only by exact synonym, so none of the new
   columns can be mistaken for a projection, a line or a pick. */
const COL = read('collective/index.html');
const synBlock = COL.slice(COL.indexOf('var SLATE_FIELDS=['), COL.indexOf('];', COL.indexOf('var SLATE_FIELDS=[')));
const SYN = (synBlock.match(/'[^']+'/g) || []).map((x) => x.slice(1, -1).toLowerCase());
const canonHead = (APP.match(/var FBP4_CANON_HEAD=\[([^\]]+)\]/) || [, ''])[1].match(/'[a-z_]+'/g).map((x) => x.slice(1, -1));
chk('the canonical export tail is eight columns', canonHead.length === 8, JSON.stringify(canonHead));
canonHead.forEach((c) => chk('the Collective maps no field from ' + c, SYN.indexOf(c) < 0));
const CLI = read('football/cfb_p4/export_csv.js');
chk('the offline export declares the same canonical tail', canonHead.every((c) => CLI.indexOf("'" + c + "'") > CLI.indexOf('var CANON_HEAD')));

if (fail) { console.log(failures.map((f) => 'FAIL | ' + f).join('\n')); console.log('\n' + pass + ' passed, ' + fail + ' failed'); process.exit(1); }
console.log('ALL GREEN ' + pass + ' passed, 0 failed');
