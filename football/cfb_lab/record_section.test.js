#!/usr/bin/env node
/* ===========================================================================
   Tests for the CFB Model Lab public record as WIRED INTO record.html.

   The EDLAB_PUB block is cut out of record.html between its markers and run
   in a sandbox against public records written by the real lab modules
   (report.publicRecord via report.run, over ledgers built by the fixture
   builders exported from football/cfb_lab/ui.test.js):

     - an empty record: the pre-season ledger (only OPEN snapshots), and the
       committed record/football/cfb_model_lab.json when it exists
     - no record at all (the file is missing)
     - a populated record: two settled weeks with wins, losses, pushes, a
       canceled game, a missed T24 window and a hostile team name

   It cannot pass against a copy that drifted from the page.

   Run: node football/cfb_lab/record_section.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const T = require('./ui.test.js');

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.message) || e) }; } }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const ROOT = path.join(__dirname, '..', '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'record.html'), 'utf8');
function slice(start, end, label) {
  const a = PAGE.indexOf(start), b = PAGE.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('record.html no longer contains ' + label);
  return PAGE.slice(a, b + end.length);
}

/* ---- structure ------------------------------------------------------------- */
chk('the EDPRES block is byte-identical to _presentation.js (unchanged by this section)', (function () {
  const canon = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_presentation.js'), 'utf8');
  const block = (s) => { const a = s.indexOf('/*__EDPRES_START__*/'), b = s.indexOf('/*__EDPRES_END__*/'); return a < 0 || b < 0 ? null : s.slice(a, b); };
  return block(PAGE) !== null && block(PAGE) === block(canon);
})());
chk('the EDLAB_PUB block sits outside EDPRES, after the briefs block', (function () {
  const i = (m) => PAGE.indexOf(m);
  return i('/*__EDPRES_END__*/') < i('/*__EDLAB_PUB_START__*/') && i('/*__EDREC_END__*/') < i('/*__EDLAB_PUB_START__*/') && i('/*__EDLAB_PUB_START__*/') < i('/*__EDLAB_PUB_END__*/')
    && PAGE.split('/*__EDLAB_PUB_START__*/').length === 2 && PAGE.split('/*__EDPRES_START__*/').length === 2;
})());
chk('the section exists with its host, and the nav links to it', /<section class="sec" id="cfb-model-lab">/.test(PAGE) && /id="labPub"/.test(PAGE) && /<a class="nlink[^"]*" href="#cfb-model-lab">/.test(PAGE));
chk('no login gate was added, and the page still says so', !/edSession|access_token|localStorage\.getItem\(.*auth/.test(PAGE) && /NO LOGIN GATE/.test(PAGE) && !/getSession|signIn|auth\.uid\(\)\s*[=!]/.test(slice('/*__EDLAB_PUB_START__*/', '/*__EDLAB_PUB_END__*/', 'the EDLAB_PUB block')));
chk('the page reads the committed record/football/cfb_model_lab.json, relatively', /FILE='\.\/record\/football\/cfb_model_lab\.json'/.test(PAGE) && !/https?:\/\/[^'"]*cfb_model_lab/.test(PAGE));
chk('the section\'s styles are fenced like the briefs\' and use the page\'s own tokens', /\/\*__EDLAB_PUB_CSS_START__\*\/[\s\S]*var\(--surface\)[\s\S]*\/\*__EDLAB_PUB_CSS_END__\*\//.test(PAGE));
chk('the games table scrolls in its own container on a phone', /\.edlab-scroll\{overflow-x:auto/.test(PAGE));

const block = slice('/*__EDLAB_PUB_START__*/', '/*__EDLAB_PUB_END__*/', 'the EDLAB_PUB block');
chk('a missing file renders the empty state rather than failing', /\.catch\(function\(\)\{ window\.EDLABPUB\.render\(null\); return null; \}\)/.test(block));
const ctx = { window: {}, document: undefined, console, Intl, Date };
ctx.window.window = ctx.window;
vm.createContext(ctx);
vm.runInContext('(function(window){' + block.replace("typeof document!=='undefined'", 'false') + '})(window)', ctx);
const R = ctx.window.EDLABPUB;
chk('EDLABPUB exposes pure renderers', R && ['rulesHTML', 'kpisHTML', 'gamesHTML', 'gameRow', 'emptyHTML', 'noteHTML', 'sectionHTML'].every((k) => typeof R[k] === 'function'));

const EMPTY_LINE = 'The Model Lab began recording on 2026-09-27; official predictions are graded after each game settles.';
const clean = (h) => !/undefined|NaN|>null</.test(h);
const count = (h, re) => (h.match(re) || []).length;

(async () => {
  /* ---- no file ---------------------------------------------------------------- */
  const miss = R.sectionHTML(null);
  chk('no file: the honest empty state, nothing invented', miss.indexOf(EMPTY_LINE) >= 0 && /has not been published yet/.test(miss) && !/<table/.test(miss) && clean(miss));

  /* ---- an empty record ----------------------------------------------------------- */
  const empties = [];
  const committed = path.join(ROOT, 'record', 'football', 'cfb_model_lab.json');
  if (fs.existsSync(committed)) empties.push({ name: 'committed record', pub: JSON.parse(fs.readFileSync(committed, 'utf8')) });
  const sp = await T.sparse(T.tmp());
  empties.push({ name: 'pre-season record', pub: sp.pub });
  empties.forEach((E) => {
    const h = R.sectionHTML(E.pub);
    chk(E.name + ': the shape is the public schema', E.pub.schema === 'edgedesk_cfb_model_lab_public_v1' && Array.isArray(E.pub.games));
    if (E.pub.games.length) return;   // the committed record may already have graded games; the populated checks below cover those
    chk(E.name + ': empty state with the start date', h.indexOf(EMPTY_LINE) >= 0 && !/<table/.test(h));
    chk(E.name + ': the rules print even before anything is graded', ['official_prediction', 'closing_line', 'ats', 'clv', 'nothing_removed'].every((k) => h.indexOf(E.pub.rules[k].replace(/&/g, '&amp;').replace(/'/g, '&#39;')) >= 0) && /<dt>Official prediction<\/dt>/.test(h) && /<dt>Nothing removed<\/dt>/.test(h));
    chk(E.name + ': counts of zero with the sample label, and dashes for the metrics', /<div class="n">0<\/div><div class="l">official predictions made/.test(h) && /<div class="n">0<\/div><div class="l">graded so far/.test(h) && /<span class="edlab-sl">small sample<\/span>/.test(h) && /<div class="n">—<\/div><div class="l">average miss on the margin/.test(h));
    chk(E.name + ': the BET-disabled, no-stake note is shown', /BET is disabled; no stake is claimed\./.test(h));
    chk(E.name + ': no "undefined", "NaN" or raw null', clean(h));
  });
  chk('a lab_started_at in the file, when report.js adds one, sets the date', /began recording on 2026-09-28;/.test(R.emptyHTML({ lab_started_at: '2026-09-28T12:00:00.000Z' })));

  /* ---- a populated record ---------------------------------------------------------- */
  const P = await T.populated(T.tmp());
  const pub = P.pub, games = pub.games;
  const h = R.sectionHTML(pub);
  const nRes = (r) => games.filter((g) => g.result === r).length;
  chk('the fixture: graded games, with wins, losses and pushes', games.length >= 20 && nRes('WIN') > 0 && nRes('LOSS') > 0 && nRes('PUSH') > 0, { n: games.length, W: nRes('WIN'), L: nRes('LOSS'), P: nRes('PUSH') });
  chk('every graded game is listed, nothing removed', count(h, /<tr class="edlab-g/g) === games.length && games.length === pub.counts.graded);
  chk('every loss is listed', count(h, />LOSS<\/span>/g) === nRes('LOSS'));
  chk('every push is shown', count(h, />PUSH<\/span>/g) === nRes('PUSH'));
  chk('every win is listed too', count(h, />WIN<\/span>/g) === nRes('WIN'));
  const posLoss = games.filter((g) => (g.decision === 'LEAN' || g.decision === 'BET') && g.result === 'LOSS').length;
  chk('every losing LEAN / BET is shown as a position, in the loss colour', posLoss > 0 && count(h, /<tr class="edlab-g">(?:(?!<\/tr>)[\s\S])*?<span class="edlab-r loss">LOSS<\/span><\/td>/g) === posLoss);
  chk('a PASS row is marked "no position", never counted as a pick', count(h, /<small>no position<\/small>/g) === games.filter((g) => g.decision !== 'LEAN' && g.decision !== 'BET' && g.result).length && /edlab-np/.test(h));
  chk('each week is a block, newest first and open', /<details class="edlab-week" open><summary>Week 7<span class="m">/.test(h) && h.indexOf('Week 7') < h.indexOf('Week 6') && count(h, /<details class="edlab-week"/g) === new Set(games.map((g) => g.week)).size);
  chk('a canceled game is void and absent; a game with no official snapshot is absent', h.indexOf('Away 7-13 @ Home 7-13') < 0 && h.indexOf('Away 7-6 @ Home 7-6') < 0 && h.indexOf('Away 7-12 @ Home 7-12') >= 0);
  const g0 = games.find((g) => g.result === 'PUSH' && g.decision === 'LEAN');
  const row = R.gameRow(g0);
  chk('a row carries kickoff, matchup, official line, win prob, final, abs error, decision, side, line, result, CLV', /ET<\/td>/.test(row) && row.indexOf(g0.official_line) >= 0 && row.indexOf('>' + (100 * g0.home_win_probability).toFixed(1) + '%<') >= 0 && row.indexOf('>' + g0.final + '<') >= 0
    && row.indexOf('>' + g0.abs_error.toFixed(1) + '<') >= 0 && /edlab-d lean">LEAN/.test(row) && row.indexOf('>' + g0.matchup.split(' @ ')[g0.side === 'HOME' ? 1 : 0] + '<') >= 0 && /edlab-r push">PUSH/.test(row) && />[+-]?\d+\.\d<\/td><\/tr>$/.test(row), row);
  chk('lines keep their sign at 1 dp', R.gameRow(Object.assign({}, g0, { line: -3, clv: 0.5 })).indexOf('<td>-3.0</td><td class="l">') >= 0 && R.gameRow(Object.assign({}, g0, { clv: 0.5 })).slice(-20).indexOf('+0.5') >= 0);

  /* counts, accuracy, research positions */
  const c = pub.counts, a = pub.accuracy, rp = pub.research_positions;
  chk('the counts print with their sample label', h.indexOf('<div class="n">' + c.official_predictions + '</div><div class="l">official predictions made') >= 0 && h.indexOf('<div class="n">' + c.graded + '</div><div class="l">graded so far') >= 0 && h.indexOf('<span class="edlab-sl">' + c.label + '</span>') >= 0);
  chk('accuracy: spread MAE, RMSE, bias, win Brier, 80% coverage', [a.spread_mae.toFixed(2), a.rmse.toFixed(2), (a.bias > 0 ? '+' : '') + a.bias.toFixed(2), a.win_brier.toFixed(3), (100 * a.coverage_80).toFixed(1) + '%'].every((x) => h.indexOf('<div class="n">' + x + '</div>') >= 0));
  chk('research positions: record, ATS %, CLV mean, positive CLV %', h.indexOf('<div class="n">' + rp.record + '</div>') >= 0 && h.indexOf('<div class="n">' + (100 * rp.ats_pct).toFixed(1) + '%</div>') >= 0
    && h.indexOf('<div class="n">' + (100 * rp.positive_clv_pct).toFixed(1) + '%</div>') >= 0 && /mean CLV/.test(h) && /BET is disabled; no stake is claimed\./.test(h));
  chk('the record counts pushes and the ATS % leaves them out, as the rules say', /pushes out/.test(h) && /pushes shown, not in the denominator/.test(h));
  chk('the rules print: official prediction, closing line, ATS, CLV, nothing removed', ['Official prediction', 'Closing line', 'ATS', 'CLV', 'Nothing removed'].every((t) => h.indexOf('<dt>' + t + '</dt>') >= 0) && /every graded official prediction is listed below, losses included/.test(h));

  /* escaping */
  chk('a hostile team name is escaped', h.indexOf(T.HOSTILE) < 0 && h.indexOf('<img') < 0 && h.indexOf('&lt;img src=x onerror=alert(1)&gt;') >= 0 && h.indexOf('A&amp;M') >= 0);
  const evil = JSON.parse(JSON.stringify(pub));
  evil.rules.nothing_removed = '<zq1>'; evil.rules['<zq2>'] = '<zq3>'; evil.counts.label = '<zq4>'; evil.research_positions.record = '<zq5>'; evil.research_positions.note = '<zq6>';
  Object.assign(evil.games[0], { final: '<zq7>', official_line: '<zq8>', decision: '"><zq9>', side: '<zq10>', result: '"><zq11>', week: '<zq12>' });
  evil.schema = '<zq13>'; evil.generated_at = '<zq14>';
  const eh = R.sectionHTML(evil);
  chk('every string from the file is escaped, class-bound values included', !/<zq/.test(eh) && [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].every((i) => eh.indexOf('&lt;zq' + i + '&gt;') >= 0), (eh.match(/.{0,40}<zq.{0,40}/) || [])[0]);
  chk('no "undefined", "NaN" or raw null in the populated record', clean(h));

  done();
})().catch((e) => { console.error(e); process.exit(1); });
