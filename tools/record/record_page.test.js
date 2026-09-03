#!/usr/bin/env node
/* ===========================================================================
   Tests for the public brief record as WIRED INTO record.html.

   The EDREC block is cut out of record.html between its markers and run in
   a sandbox with the real presentation library, against a fixture record
   shaped exactly like tools/record/grade_briefs.js writes. It cannot pass
   against a copy that drifted from the page.

   Run: node tools/record/record_page.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0; const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.message) || e) }; } }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function done() {
  failures.forEach(f => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const ROOT = path.join(__dirname, '..', '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'record.html'), 'utf8');
const P = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_presentation.js'));
const G = require(path.join(__dirname, 'grade_briefs.js'));

function slice(start, end, label) {
  const a = PAGE.indexOf(start), b = PAGE.indexOf(end, a);
  if (a < 0 || b < 0) throw new Error('record.html no longer contains ' + label);
  return PAGE.slice(a, b + end.length);
}

/* ---- structure ------------------------------------------------------------- */
chk('record.html carries the presentation library (fourth host), in sync', (function () {
  const canon = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_presentation.js'), 'utf8');
  const block = s => { const a = s.indexOf('/*__EDPRES_START__*/'), b = s.indexOf('/*__EDPRES_END__*/'); return s.slice(a, b); };
  return block(PAGE) === block(canon) && PAGE.indexOf('/*__EDPRES_START__*/') < PAGE.indexOf('/*__EDREC_START__*/');
})());
chk('the section exists with its hosts and the nav links to it', /id="briefs"/.test(PAGE) && /id="recBriefs"/.test(PAGE) && /id="recBriefChips"/.test(PAGE) && /href="#briefs"/.test(PAGE));
chk('no login gate was added', !/edSession|access_token|localStorage\.getItem\(.*auth/.test(PAGE));
chk('the page reads the committed record, not the database, for briefs', /record\/grades\.json/.test(PAGE));

/* ---- the renderer against a fixture record ---------------------------------- */
const block = slice('/*__EDREC_START__*/', '/*__EDREC_END__*/', 'the EDREC block');
const ctx = { window: {}, document: undefined, console };
ctx.window.EDPRES = P;
ctx.window.window = ctx.window;
vm.createContext(ctx);
vm.runInContext('(function(window){' + block.replace("typeof document!=='undefined'", 'false') + '})(window)', ctx);
const R = ctx.window.EDREC;
chk('EDREC exposes pure renderers', R && typeof R.listHTML === 'function' && typeof R.kpisHTML === 'function' && typeof R.chipsHTML === 'function');

const AFTER = Date.parse('2026-09-11T09:00:00Z');
function price(o) { return Object.assign({ event_id: 'ev1', matchup: 'Chiefs @ Ravens', market: 'Spread', market_key: 'spreads', selection: 'Chiefs +3.5', selection_raw: 'Chiefs', line: 3.5, odds: '-110', odds_am: -110, book: 'DraftKings', captured_at: '2026-09-10T18:00:00Z', verdict: 'BET', kind: 'pick', rank: 1, commence: '2026-09-11T00:15:00Z', sport_key: 'americanfootball_nfl', sport_label: 'NFL', home: 'Ravens', away: 'Chiefs' }, o || {}); }
const rows = [
  { id: 'b1', share_slug: 'abcdefghijkl', report_type: 'GAME', preset: 'TNF', version_no: 2, sport: 'americanfootball_nfl', sport_label: 'NFL', title: 'Thursday Night Football', event_label: 'Chiefs at Ravens', when_label: 'Thursday, Sep 10, 8:15 PM ET', generated_at: '2026-09-10T18:05:00Z',
    public_payload: { cards: [{ rank: 1, brief: { call: { verdict: 'BET' } } }], watch: [], slate: null, data_status: { prices: [price()] } } },
  { id: 'b2', share_slug: 'mmmmmmmmmmmm', report_type: 'SLATE', preset: 'CFB', version_no: 1, sport: 'americanfootball_ncaaf', sport_label: 'CFB', title: 'College Football', event_label: null, when_label: 'Saturday · Week 2', generated_at: '2026-09-04T18:00:00Z',
    public_payload: { cards: [], watch: [{ rank: 1, brief: { call: { verdict: 'LEAN' } } }], slate: { headline: 'NO QUALIFYING BETS', no_bet: true, counts: { bet: 0, lean: 1, wait: 0, pass: 2, failed: 0 } },
      data_status: { prices: [price({ event_id: 'ev9', matchup: 'Texas Tech @ Baylor', selection: 'Baylor -3.5', selection_raw: 'Baylor', line: -3.5, odds: '-108', odds_am: -108, verdict: 'LEAN', kind: 'watch', commence: '2026-09-05T23:30:00Z', sport_key: 'americanfootball_ncaaf', sport_label: 'CFB', home: 'Baylor', away: 'Texas Tech' })] } } },
  { id: 'b3', share_slug: 'zzzzzzzzzzzz', report_type: 'GAME', preset: 'SNF', version_no: 1, sport: 'americanfootball_nfl', sport_label: 'NFL', title: 'Sunday Night Football', event_label: 'Cowboys at Eagles', when_label: 'Sunday, Sep 13, 8:20 PM ET', generated_at: '2026-09-12T18:05:00Z',
    public_payload: { cards: [{ rank: 1, brief: { call: { verdict: 'LEAN' } } }], watch: [], slate: null, data_status: { prices: [price({ event_id: 'ev3', matchup: 'Cowboys @ Eagles', selection: 'Over 47.5', selection_raw: 'Over', market: 'Total', market_key: 'totals', line: 47.5, odds: '-105', odds_am: -105, verdict: 'LEAN', commence: '2026-09-14T00:20:00Z', home: 'Eagles', away: 'Cowboys' })] } } },
];
const closes = [
  { event_id: 'ev1', market: 'spreads', selection: 'Chiefs', point: 3.5, home_team: 'Ravens', away_team: 'Chiefs', commence_time: '2026-09-11T00:15:00Z', best_dec: 1.8, best_book: 'FanDuel', closing_sharp_fair: 0.5556, closed_at: '2026-09-11T00:10:00Z', result: 'win', graded_at: '2026-09-11T04:00:00Z' },
  { event_id: 'ev9', market: 'spreads', selection: 'Baylor', point: -3.5, home_team: 'Baylor', away_team: 'Texas Tech', commence_time: '2026-09-05T23:30:00Z', best_dec: 1.9, best_book: 'DraftKings', closing_sharp_fair: 0.5, closed_at: '2026-09-05T23:25:00Z', result: 'loss', graded_at: '2026-09-06T04:00:00Z' },
];
const rec = G.buildRecord(rows, closes, {}, null, AFTER, { closeSource: 'ok', closeSourceName: 'public_brief_closes' });
rec.generated_at = new Date(AFTER).toISOString();

const all = R.listHTML(rec, 'ALL', 12);
chk('every brief renders, newest first', all.indexOf('Sunday Night Football') < all.indexOf('Thursday Night Football') && all.indexOf('Thursday Night Football') < all.indexOf('College Football'));
chk('the graded call shows the published price, the close and the receipt', /-110<\/b> DraftKings/.test(all) && /close -125/.test(all) && /Closed -125\. Beat the close by 15 cents\. Won\./.test(all));
chk('the closing board price is labelled by book', /board -125 FanDuel/.test(all));
chk('a same-book close, when on file, is shown as closed at the book with the fair beside it', (function () {
  const r2 = G.buildRecord([rows[0]], closes, {}, null, AFTER, { closeSource: 'ok', bookRows: [{ sig_key: 'ev1|spreads|Chiefs|3.5', book_key: 'draftkings', book_title: 'DraftKings', dec: 1.8, seen_at: '2026-09-11T00:05:00Z', lead_minutes: 10 }] });
  const h = R.listHTML(r2, 'ALL', 12); return /closed -125 DraftKings · fair -125/.test(h) && /Beat the book’s close by 15 cents/.test(h);
})());
chk('a NO QUALIFYING BETS slate is labelled as discipline, not dropped', /No qualifying bets/.test(all) && /RESEARCH/.test(all));
chk('the research row on the no-bet slate shows its own grade', /Missed the close by 8 cents\. Lost\./.test(all), all.match(/Missed[^<]*/) && all.match(/Missed[^<]*/)[0]);
chk('a brief whose game has not kicked off waits, visibly', /Not kicked off yet\./.test(all));
chk('the share link and the version travel with the brief', /brief\.html\?s=abcdefghijkl/.test(all) && /v2/.test(all));
chk('the published time stamp is ET', /published .*ET/.test(all));
chk('no HTML injection through a title', (function () {
  const evil = G.buildRecord([Object.assign({}, rows[0], { id: 'bx', title: '<img src=x onerror=alert(1)>' })], [], {}, null, AFTER, {});
  return R.listHTML(evil, 'ALL', 12).indexOf('<img') < 0;
})());

/* filters */
chk('the CFB chip filters to the slate alone', (function () { const h = R.listHTML(rec, 'CFB', 12); return /College Football/.test(h) && !/Thursday Night Football/.test(h); })());
chk('a preset with nothing published is an honest empty state', /No published briefs for this preset yet/.test(R.listHTML(rec, 'MNF', 12)));
chk('chips carry counts and hide empty presets except All', (function () { const h = R.chipsHTML(rec, 'ALL'); return /TNF<span class="n">1/.test(h) && /All<span class="n">3/.test(h) && !/MNF/.test(h); })());
chk('paging says how many more', /Show 1 more of 3/.test(R.listHTML(rec, 'ALL', 2)));

/* KPIs */
const k = R.kpisHTML(rec, 'ALL');
chk('the KPIs count calls (BET + LEAN picks), graded, beat rate, cents and discipline', /3<\/div><div class="l">briefs published/.test(k) && /2<\/div><div class="l">calls published/.test(k) && /100%<\/div><div class="l">beat the close/.test(k) && /\+15<\/div><div class="l">avg cents/.test(k) && /1<\/div><div class="l">no-bet briefs \(discipline\)/.test(k), k);
chk('the win-loss tile is labelled context only', /W-L[^<]*\(context only\)/.test(k));
chk('KPIs follow the preset filter', /1<\/div><div class="l">briefs published/.test(R.kpisHTML(rec, 'CFB')));

/* empty + deploy-state notes */
chk('an empty record renders the honest empty state', /No published briefs yet/.test(R.listHTML({ briefs: [] }, 'ALL', 12)));
chk('a missing close view is named in the note', /brief_record\.sql/.test(R.noteHTML({ briefs: [], source: { close: null } })));
chk('the note explains what the close and the cents are', /closing fair line/.test(R.noteHTML(rec)) && /15 cents/.test(R.noteHTML(rec)));

done();
