#!/usr/bin/env node
/* ===========================================================================
   One list of which sports EdgeDesk offers: lib/edgedesk_sports.js (EDSPORTS).

   Retiring a sport should be an edit to that file, not a hunt through the
   repository. This suite holds every place that must follow it:

     1  every host carries the canonical block, byte for byte
     2  the helpers mean what they say (keys, legacy titles, the PostgREST rule,
        the support boundary and its history carve-out)
     3  the Research navigation is exactly Desk + the configured coverage +
        Stats + Lab, with no tab or panel for a retired module, and its old
        routes come from the config
     4  the desk's card-wide board supports no retired sport
     5  capture and close never request odds for a retired sport
     6  no retired sport's workflow runs on a schedule
     7  the terminal's live pools, record and Lab list, and the public record
        page, read through the config — and the record keeps an archive view

   Run: node tools/app/sports_config.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 300); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 300) : ''));
}
function has(hay, needle, name) { chk(name, String(hay).indexOf(needle) >= 0, 'missing: ' + needle); }
function lacks(hay, needle, name) { chk(name, String(hay).indexOf(needle) < 0, 'unexpectedly present: ' + needle); }

const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const S = require(path.join(ROOT, 'lib', 'edgedesk_sports.js'));
const INLINE = require(path.join(ROOT, 'tools', 'presentation', 'inline.js'));

/* ---- 1. one block, every host ----------------------------------------- */
const lib = INLINE.LIBS.find((l) => l.name === 'EDSPORTS');
chk('inline.js carries the EDSPORTS library', !!lib);
if (lib) {
  const src = fs.readFileSync(lib.src, 'utf8');
  const canon = src.slice(src.indexOf(lib.start), src.indexOf(lib.end) + lib.end.length);
  const want = ['app.html', 'record.html', 'supabase/functions/edgedesk_ai/index.ts',
    'supabase/functions/capture/index.ts', 'supabase/functions/close/index.ts'];
  want.forEach((h) => {
    chk('EDSPORTS is hosted by ' + h, lib.hosts.some((x) => path.relative(ROOT, x) === h));
    const t = read(h);
    const got = t.slice(t.indexOf(lib.start), t.indexOf(lib.end) + lib.end.length);
    chk(h + ' carries the canonical block byte for byte', got === canon);
  });
}

/* ---- 2. the helpers ----------------------------------------------------- */
const TENNIS = S.RETIRED.find((r) => r.id === 'tennis');
chk('Tennis is retired', !!TENNIS);
chk('every tennis_* key is retired', ['tennis_atp_us_open', 'tennis_wta_guadalajara_open', 'tennis'].every(S.isRetiredKey));
chk('no current sport key is', ['americanfootball_nfl', 'americanfootball_ncaaf', 'baseball_mlb', 'mma_mixed_martial_arts',
  'basketball_nba', 'icehockey_nhl'].every((k) => !S.isRetiredKey(k)));
chk('a legacy row with no key is judged by its title', S.isRetiredRow({ sport_title: 'ATP Washington Open' })
  && S.isRetiredRow({ sport_title: 'WTA Cincinnati Open' }) && !S.isRetiredRow({ sport_title: 'MLB' }));
chk('a row with a key is judged by its key', !S.isRetiredRow({ sport_key: 'baseball_mlb', sport_title: 'ATP' }));
chk('dropRetired keeps every current row and nothing else',
  S.dropRetired([{ sport_key: 'tennis_atp_x' }, { sport_key: 'baseball_mlb' }, { sport_title: 'WTA Open' }, { sport_title: 'NFL' }])
    .map((r) => r.sport_key || r.sport_title).join() === 'baseball_mlb,NFL');
chk('the PostgREST rule keeps NULL keys and drops every retired prefix',
  S.postgrestKeep('sport_key') === 'or=(sport_key.is.null,sport_key.not.like.tennis_*)', S.postgrestKeep('sport_key'));
chk('old research modules land on the default', JSON.stringify(S.retiredModuleRoutes()) === JSON.stringify({ tennis: 'football', wta: 'football' }));
chk('the boundary sentence', S.unsupportedAnswer(TENNIS) === 'Tennis is not currently supported by EdgeDesk Research. Current research coverage includes Football, UFC and Baseball.');
[['Who has value in this ATP match?', true], ['Best WTA bets today?', true], ['Research Alcaraz vs Sinner', false],
 ['Any tennis edges?', true], ['Why did you stop covering tennis?', false], ['How does Texas State look?', false],
 ['Is Deshaun Watson starting?', false]].forEach(([q, want]) => {
  chk('supportBoundary("' + q + '") is ' + (want ? 'the boundary' : 'null'), !!S.supportBoundary({ question: q }) === want);
});
chk('a turn resolved to a tennis key is the boundary whatever its words', !!S.supportBoundary({ question: 'this one?', sportKey: 'tennis_wta_x' }));

/* ---- 3. the Research navigation ------------------------------------------ */
const APP = read('app.html');
const nav = (APP.match(/<div class="stseg research-sub"[^\n]*?<\/div>/) || [''])[0];
const subs = (nav.match(/data-sub="([a-z]+)"/g) || []).map((x) => x.slice(10, -1));
chk('the Research tabs are Desk, the configured coverage, Stats and Lab',
  JSON.stringify(subs) === JSON.stringify(['rdesk'].concat(S.RESEARCH_COVERAGE.map((c) => c.id), ['stats', 'lab'])), subs);
S.RETIRED.forEach((r) => r.modules.forEach((m) => {
  chk('no Research tab for retired module ' + m, subs.indexOf(m) < 0);
  lacks(APP, 'id="v-' + m + '"', 'no panel for retired module ' + m);
  lacks(APP, "researchRegister({id:'" + m + "'", 'no registration for retired module ' + m);
}));
has(APP, 'var RS_RETIRED=EDSPORTS.retiredModuleRoutes();', 'old research routes come from the config');

/* ---- 4. the desk's board ------------------------------------------------- */
const BOARD = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_board.js'));
chk('the board supports no retired sport', Object.keys(BOARD.SUPPORTED).every((k) => !S.isRetiredKey(k)), Object.keys(BOARD.SUPPORTED));
chk('and no board sport word names one', BOARD.detectSports('best tennis bets today').every((k) => !S.isRetiredKey(k)));

/* ---- 5. nothing buys odds for a retired sport ---------------------------- */
const CAP = read('supabase/functions/capture/index.ts');
const capSports = CAP.indexOf('sports = EDSPORTS.keepCurrentKeys(sports);');
chk('capture drops retired keys from its sport list', capSports > 0);
chk('before its first odds request', capSports > 0 && capSports < CAP.indexOf('if (probe) {', CAP.indexOf('// ---- sports -')));
has(CAP, '.filter((p) => !EDSPORTS.isRetiredKey(p))', 'a retired prefix in CAPTURE_AUTO_PREFIXES is dropped');
lacks(CAP, '? ["tennis_", ', 'the default auto prefixes no longer carry tennis_');
const CLOSE = read('supabase/functions/close/index.ts');
const closeSkip = CLOSE.indexOf('if (EDSPORTS.isRetiredKey(sport)) {');
chk('close never requests a live close for a retired sport', closeSkip > 0 && closeSkip < CLOSE.indexOf('await fetchOdds(sport, MARKETS)'));

/* ---- 6. no retired workflow runs on a schedule --------------------------- */
['tennis-live', 'tennis-sync', 'tennis-record'].forEach((w) => {
  const y = read('.github/workflows/' + w + '.yml');
  const on = y.slice(y.indexOf('\non:'), y.indexOf('\n', y.indexOf('workflow_dispatch:')));
  chk(w + ' has no schedule', !/^\s*schedule:/m.test(on) && !/^\s*- cron:/m.test(on), on.slice(0, 200));
  has(y, 'workflow_dispatch:', w + ' can still be run by hand');
});
has(read('.github/workflows/tennis-live.yml'), 'EXTRA="--no-dispatch"', 'a manual tennis poll never hands itself a continuation');

/* ---- 7. the terminal and the public record read through the config ------- */
has(APP, 'function dropRetiredSports(rows){return EDSPORTS.dropRetired(rows);}', 'the live pools drop retired sports via EDSPORTS');
has(APP, 'EDGES=dropRetiredSports(_edgesFetched);', 'the bettable board is one of them');
has(APP, 'function recScopeQ(){return REC.archive?\'\':EDSPORTS.postgrestKeep(\'sport_key\');}', 'the record scope is the config rule');
has(APP, 'sbCount(recScopeF(\'graded_at=not.is.null&\'+FLAG_CLV))', 'the record counts are scoped');
has(APP, 'rows=recScopeRows(rows);', 'the record rows are scoped');
has(APP, 'id="rfArchive"', 'the record keeps an explicit archive view');
has(APP, "'&order=graded_at.desc&limit=150')", 'the Lab reads its recent graded signals');
has(APP, "EDSPORTS.postgrestKeep('sport_key')+'&order=graded_at.desc&limit=150')", 'and scopes them to the current product');
has(APP, 'var _sb=window.EDSPORTS&&EDSPORTS.supportBoundary(', 'the panel applies the support boundary before calling the desk');
{
  /* every signals read inside the record tab's code carries the scope */
  const a = APP.indexOf('async function loadRecord(force){'), b = APP.indexOf('/* ---- filter options built from real data only ---- */');
  const reads = (APP.slice(a, b).match(/sb(Get|GetAll)\('signals\?[^;]*;/g) || []);
  chk('every signals read in loadRecord is scoped', reads.length > 0 && reads.every((r) => /recScope/.test(r)), reads);
}
const REC = read('record.html');
lacks(REC, "sbGet('public_record", 'the public record page reads public_record only through recordRows');
has(REC, 'var REC_ARCHIVE=/[?&]archive=1(&|$)/.test(location.search);', 'and keeps an explicit archive view (?archive=1)');

/* the public page's reader, run: scoped by default, archive on request, and a
   view without sport columns degrades to what the page always read */
{
  const a = REC.indexOf('/*__EDSPORTS_START__*/'), b = REC.indexOf('/*__EDSPORTS_END__*/') + '/*__EDSPORTS_END__*/'.length;
  const fa = REC.indexOf('var REC_ARCHIVE='), fb = REC.indexOf('\n}\n', REC.indexOf('async function recordRows(q){')) + 3;
  function run(search, sbGet) {
    const ctx = { location: { search }, console: { warn() {} }, sbGet };
    ctx.globalThis = ctx;
    vm.createContext(ctx);
    vm.runInContext(REC.slice(a, b) + '\n' + REC.slice(fa, fb) + '\nthis.recordRows=recordRows;', ctx);
    return ctx.recordRows;
  }
  const rows = [{ clv: 0.01, sport_key: 'baseball_mlb' }, { clv: 0.02, sport_key: 'tennis_atp_x' }, { clv: 0.03, sport_title: 'WTA Open' }];
  let asked = [];
  const sb = async (q) => { asked.push(q); return rows; };
  const def = run('', sb);
  const arc = run('?archive=1', sb);
  Promise.all([def('public_record?select=clv,result&limit=5'), arc('public_record?select=clv,result&limit=5')]).then(([d, r]) => {
    chk('the public record drops retired rows by default', d.length === 1 && d[0].sport_key === 'baseball_mlb', d);
    chk('and asks the view for the sport columns to do it', /select=sport_key,sport_title,clv,result/.test(asked[0]), asked[0]);
    chk('?archive=1 reads every row as stored', r.length === 3, r.length);
    asked = [];
    const noCols = run('', async (q) => {
      asked.push(q);
      if (/sport_key/.test(q)) { const e = new Error('HTTP 400'); e.missingColumn = true; e.detail = 'column public_record.sport_key does not exist'; throw e; }
      return rows;
    });
    return noCols('public_record?select=clv,result&limit=5');
  }).then((d) => {
    chk('a view without sport columns degrades to the original read, not an error', d.length === 3 && asked.length === 2 && !/sport_key/.test(asked[1]), asked);
  }).catch((e) => chk('record page reader ran', false, String(e && e.stack || e))).then(finish);
}

function finish() {
  failures.forEach((f) => console.log('FAIL | ' + f));
  console.log('sports config: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}
