#!/usr/bin/env node
/* ============================================================================
   THE CFB RESEARCH VIEW, PUBLISHED.

   The board reads every college game through lib/cfb_research_view.js: one
   research label, the market gap from the raw margin, confidence and
   reliability apart, the engine's own reasons, the best current quote and
   the projection's published history. This file pins where that read goes
   once it leaves the board — the research payload app.html fbBriefGame()
   returns, and everything that reads it:

     1  the contract   V.brief() — device-free, clock-free, rounded, and
                       carrying no word or number of its own
     2  the payload    fbBriefGame().research_view, through the real module,
                       the same label the board shows, never this browser's
                       last visit
     3  the brief      the publisher brief's web, CMS and text renderers
     4  the article    a "Research read" section, and the publication checks
     5  the snapshot   the verbatim payload, a top-level copy and citable facts;
                       the content hash does not move with the clock
     6  the narration  the model is handed the measured reasons, and a number
                       from the read is a supported number
     7  the host       the headless build loads the view, its freshness policy
                       and the record, and runs the terminal's own loader
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const M = require('./_module.js');
const ROOT = M.ROOT;
const V = require(path.join(ROOT, 'lib', 'cfb_research_view.js'));
const P = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_presentation.js'));
const AMODEL = require(path.join(ROOT, 'tools', 'articles', 'article_model.js'));
const ARENDER = require(path.join(ROOT, 'tools', 'articles', 'article_render.js'));
const SNAP = require(path.join(ROOT, 'tools', 'editorial', 'snapshot.js'));
const NARRATE = require(path.join(ROOT, 'tools', 'editorial', 'narrate.js'));
const QUALITY = require(path.join(ROOT, 'tools', 'editorial', 'quality.js'));

let checks = 0, failures = 0;
function ok(cond, what, detail) {
  checks++;
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { detail = String(e && e.stack || e).slice(0, 400); cond = false; } }
  if (cond) return;
  failures++; console.error('  FAIL: ' + what + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 400)));
}
function eq(a, b, what) { ok(a === b, what + ' (got ' + JSON.stringify(a) + ', wanted ' + JSON.stringify(b) + ')'); }
function has(hay, needle, what) { ok(String(hay).indexOf(needle) >= 0, what, { missing: needle }); }
function lacks(hay, needle, what) { ok(String(hay).indexOf(needle) < 0, what, { present: needle }); }
function section(t) { console.log('\n' + t); }
const NOTHING = /(^|[\s>(])(null|undefined|NaN)([\s<).,;:]|$)/;
function strings(v, acc) {
  acc = acc || [];
  if (typeof v === 'string') acc.push(v);
  else if (v && typeof v === 'object') Object.keys(v).forEach(k => strings(v[k], acc));
  return acc;
}

/* ------------------------------------------------------------------------ */
section('1 · the contract: V.brief()');
global.EDCfbP4Params = require(path.join(ROOT, 'football', 'cfb_p4', 'params.js'));
const ENG = require(path.join(ROOT, 'football', 'cfb_p4', 'engine.js'));
function proj(raw, o) {
  o = o || {};
  const fl = ENG.fairLine.normalize(raw, {});
  return { status: 'PREDICTED', model_version: 'edgedesk_cfb_p4_v1.0.0',
    model: { fair_spread: raw, display_fair_spread: fl.display_fair_spread, display_side: fl.display_side,
      is_near_pickem: fl.is_near_pickem, display_basis: fl.basis },
    scores: { confidence: o.conf == null ? 64.4 : o.conf },
    contributions: [{ key: 'rating', points: raw * 0.8, available: true, confidence: 0.8 },
      { key: 'hfa', points: 2.1, available: true, confidence: 0.9 }],
    explanation: { primary_drivers: [] }, layers: {} };
}
const GAME = { game_id: 'P1', home: 'Duke', away: 'Wake Forest' };
const REC = { first: { at: '2026-09-20T12:00:00Z', margin: -3.0 }, latest: { at: '2026-09-23T12:00:00Z', margin: -3.6 }, revisions: 2 };
function view(raw, line, o) {
  o = o || {};
  return V.build({ game: GAME, projection: proj(raw, o), market: line == null ? null : { spread_line: line, book: 'cfb.lines · consensus' },
    coverage: o.coverage || { input_coverage: 0.82, known: 14, applicable: 17 }, record: o.record === undefined ? REC : o.record,
    visit: o.visit || null, parity: o.parity || null, now: o.now || Date.parse('2026-09-24T18:00:00Z') });
}
{
  const b = V.brief(view(-4.1, 1.5));
  eq(b.contract, 'cfb_research_brief/1', 'the published contract is named');
  eq(b.view, V.version, 'and names the view it was cut from');
  eq(b.label.key, 'WORTH_RESEARCHING', 'it carries the one research label');
  ok(b.label.means && b.label.rule, 'with its rule and its words');
  eq(b.fair.line_text, 'Wake Forest -4.1', 'the fair line, named for its side');
  eq(b.market_gap.points, 5.6, 'the gap, measured from the raw margin');
  eq(b.market_gap.measured_from, 'raw', 'and says so');
  eq(b.confidence.tier, 'HIGH', 'confidence as a tier');
  eq(b.reliability.pct, 82, 'reliability as its own number');
  ok(b.drivers && b.drivers.reasons.length > 0 && b.drivers.reasons.every(r => typeof r.text === 'string'), 'the engine’s reasons, in fixed words', b.drivers);
  eq(b.published.length, 2, 'the published path: first and latest');
  ok(b.published.every(p => p.source !== 'current'), 'and never the live number’s own "now" stamp');
  eq(b.change_since_published.comparable, true, 'the change since the latest published number is comparable');
  has(b.note, 'Research, not picks', 'it says what it is');
  eq(V.brief(null), null, 'no view, no brief');

  /* the same game, read an hour apart, publishes the same brief */
  const a1 = JSON.stringify(V.brief(view(-4.1, 1.5, { now: Date.parse('2026-09-24T18:00:00Z') })));
  const a2 = JSON.stringify(V.brief(view(-4.1, 1.5, { now: Date.parse('2026-09-24T19:00:00Z') })));
  eq(a1, a2, 'an unchanged game publishes an unchanged brief, whatever the clock says');

  /* a view measured against this browser's last visit is never published */
  const visit = { t: Date.parse('2026-09-24T10:00:00Z'), m: -3.0, c: { rating: -2.4 }, k: 1.5, s: 'cfb.lines · consensus', l: 'MARKET_ALIGNED', g: 4.5, v: 'edgedesk_cfb_p4_v1.0.0', q: 1 };
  const vv = view(-4.1, 1.5, { visit });
  eq(vv.what_changed.basis, 'visit', 'the board’s own view measures from the visit');
  eq(V.brief(vv), null, 'and V.brief refuses it: a document cannot depend on who opened the board');

  /* a load that is not comparable publishes that, in words */
  const nc = V.brief(view(-4.1, 1.5, { parity: { ok: false, gaps: ['the play-level efficiency the published build prices from did not load'] } }));
  eq(nc.parity.ok, false, 'parity travels with the brief');
  eq(nc.projection_status.key, 'NOT_COMPARED', 'and the status says NOT COMPARED');
  eq(nc.change_since_published.comparable, false, 'the change is marked not comparable');

  /* every label, and no language a document may not carry */
  const all = [view(-4.1, 1.5), view(-0.4, 0.5), view(-12, 1.5), view(-2, -1.9), view(-4, null), view(-4, 1.5, { conf: 20 }),
    view(-4, 1.5, { coverage: { input_coverage: 0.4 } }), view(-30, 1.5)].map(V.brief);
  const keys = {}; all.forEach(x => { keys[x.label.key] = 1; });
  eq(Object.keys(keys).length, 6, 'the six labels all publish');
  const text = all.map(x => strings(x).join(' \n ')).join(' \n ');
  ok(!AMODEL.FORBIDDEN.test(text), 'no brief carries the article model’s forbidden language', (text.match(AMODEL.FORBIDDEN) || [])[0]);
  ok(!NOTHING.test(text), 'and no stringified nothing', (text.match(NOTHING) || [])[0]);
  ok(!/\b(lock|best bet|guaranteed|hammer)\b/i.test(text), 'no pick language');
}

/* ------------------------------------------------------------------------ */
section('2 · the payload: fbBriefGame().research_view, through the real module');
const BOOT = M.boot({ probe: ['fbP4ViewFor', 'fbP4Request', 'fbP4Market', 'fbP4ContractFor', 'fbP4BriefView'] });
if (BOOT.error) { console.error('the football module would not run: ' + (BOOT.error.message || BOOT.error)); process.exit(1); }
const win = BOOT.win, T = win.__FBTEST;
const E = M.loadEngine(win, ROOT);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'lib', 'cfb_research_view.js'), 'utf8'), win, { filename: 'lib/cfb_research_view.js' });
const HOME = 'Duke', AWAY = 'Wake Forest', HK = E.normKey(HOME), AK = E.normKey(AWAY);
/* a staged board stands for a complete load (see cfb_research_view_ui.test.js) */
function stage(target, o) {
  o = o || {};
  const st = E.newState();
  st.canonicalRatingMeta = { schema: 'staged' };
  st.canonicalRatings = {}; st.canonicalRatings[HK] = { value: 0 }; st.canonicalRatings[AK] = { value: 0 };
  win.FB.p4.state = st;
  win.FB.p4.engineEfficiency = { schema: 'edgedesk_cfb_engine_efficiency_v1', staged: true };
  win.FB.p4.efficiencyReplay = { games: 0, team_rows: 0, missing: 0, error: null, late_joined: 0 };
  win.FB.p4.schedFallback = [];
  const sg = { home: HOME, away: AWAY, market_spread: o.market_spread, home_conference: 'ACC', away_conference: 'ACC', game_id: 'PB1' };
  let u = M.stageGame(win, sg);
  const rest = E.projectGame(T.fbP4Request(u)).model.fair_spread;
  st.canonicalRatings[HK].value = target - rest;
  u = M.stageGame(win, sg);
  const p = E.projectGame(T.fbP4Request(u));
  win.FB.p4._proj = { PB1: p }; win.FB.p4._mkt = { PB1: T.fbP4Market(u) };
  T.fbP4ContractFor(u);
  u._contract.v = { rows: [], summary: { input_coverage: 0.82, known: 14, applicable: 17 } };
  return { u, p };
}
function research() { return win.fbBriefGame({ home: HOME, away: AWAY, t: Date.parse('2026-09-19T23:30:00.000Z') }); }
{
  /* cfb.lines convention: Duke (home) -1.5; EdgeDesk has Wake Forest by 4.1 */
  const s = stage(-4.1, { market_spread: -1.5 });
  const r = research();
  ok(r && r.kind === 'CFB_GAME', 'the brief is built');
  const rv = r.research_view;
  ok(rv && rv.contract === 'cfb_research_brief/1', 'and carries the published research view', rv && rv.contract);
  const board = T.fbP4ViewFor(s.u, s.p);
  eq(rv.label.key, board.research_label.key, 'with the label the board shows for the same game');
  eq(rv.market_gap.points, Math.round(board.market_gap.points * 100) / 100, 'and the board’s gap');
  eq(rv.fair.line_text, board.fair.fair_line_text, 'and the board’s fair line');
  eq(rv.parity.ok, true, 'a complete load publishes as comparable');
  ok(r.projection && r.market && r.drivers, 'every section the brief carried before is still there');

  /* the board has a visit baseline; the brief does not use it */
  win.FB.p4seen = { base: { v: 2, at: Date.now() - 3600e3, games: { PB1: { t: Date.now() - 3600e3, m: -3.0, c: { rating: -2 }, k: null, s: null, l: 'MARKET_ALIGNED', g: null, v: s.p.model_version, q: 1 } } }, read: true, wroteAt: 0 };
  s.u._rv = null; s.u._rvp = null;
  eq(T.fbP4ViewFor(s.u, s.p).what_changed.basis, 'visit', 'the board’s card measures from this device’s last visit');
  const r2 = research();
  ok(r2.research_view && (!r2.research_view.what_changed || r2.research_view.what_changed.summary.indexOf('your last visit') < 0),
    'the published view never does', r2.research_view && r2.research_view.what_changed);
  win.FB.p4seen = { base: null, read: true, wroteAt: 0 };

  /* absent the view, the payload is exactly what it was */
  /* unloaded from inside the page's own context, where the module reads it */
  vm.runInContext('window.__rvSaved = window.EDCfbResearchView; window.EDCfbResearchView = undefined;', win);
  s.u._rvp = null;
  const r3 = research();
  eq(r3.research_view, null, 'without the view loaded the payload carries none');
  vm.runInContext('window.EDCfbResearchView = window.__rvSaved;', win);
  has(BOOT.module, 'research_view:researchView', 'fbBriefGame returns it');
  has(BOOT.module, 'function fbP4BriefView(u,p)', 'through one adapter');
}

/* ------------------------------------------------------------------------ */
section('2b · the AI desk is handed the same read');
{
  const s = stage(-4.1, { market_spread: -1.5 });
  const want = JSON.stringify(research().research_view);
  eq(typeof win.fbP4ResearchBriefFor, 'function', 'the page exports the research read for one board game');
  eq(JSON.stringify(win.fbP4ResearchBriefFor({ game_id: 'PB1' })), want, 'by game id: the brief’s own research view');
  eq(JSON.stringify(win.fbP4ResearchBriefFor({ home: HOME, away: AWAY })), want, 'by the two team names');
  eq(JSON.stringify(win.fbP4ResearchBriefFor({ home: AWAY, away: HOME })), want, 'and with the names the other way round');
  eq(win.fbP4ResearchBriefFor({ game_id: 'NOT_ON_THE_BOARD' }), null, 'a game the board has not loaded has none');
  void s;
  /* the desk's two packets carry it (EDAI, a separate block of app.html) */
  has(BOOT.app, "research_view:sk===EDINTEL.CFB_SPORT?cfbResearchView({game_id:res.game_id,home:res.home,away:res.away}):null",
    'a named-matchup packet carries the research view');
  has(BOOT.app, "?cfbResearchView({event:{home:e.home_team,away:e.away_team,t:e.commence_time}}):null",
    'and so does a college signal’s packet');
  has(BOOT.app, 'h+=deskBoardReadHTML(D.focus);', 'the desk’s short answer prints the board’s read of its focus game');
  const TS = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts'), 'utf8');
  has(TS, 'use ONLY research_view.drivers.reasons', 'the server tells the model to give no reason the view does not');
  has(TS, 'RESEARCH VIEW — on a college game', 'and its system prompt says what the view is');
}

/* ------------------------------------------------------------------------ */
section('3 · the publisher brief: web, CMS and text');
let RESEARCH = null;
{
  stage(-4.1, { market_spread: -1.5 });
  RESEARCH = research();
  const snap = P.snapshot({ cards: [], report_type: 'GAME', preset: 'CFB', research: RESEARCH, event_label: AWAY + ' at ' + HOME });
  const block = snap.public.research;
  ok(block && block.research_read, 'the public payload carries the research read');
  eq(block.research_read.label, RESEARCH.research_view.label.label, 'with the same label');
  const html = P.briefHTML(snap), cms = P.briefCmsHTML(snap), text = P.briefText(snap);
  has(html, 'Research read', 'the web brief has the section');
  has(html, esc(RESEARCH.research_view.label.label), 'and prints the label');
  has(html, 'Why EdgeDesk leans ' + AWAY, 'and the reasons, under the side they are for');
  has(cms, '<h3>Research read</h3>', 'the CMS paste carries it');
  has(text, 'RESEARCH READ', 'and so does the plain text');
  has(text, 'Market gap: ' + RESEARCH.research_view.market_gap.text, 'with the gap in the view’s words');
  ok(!NOTHING.test(html.replace(/edb-nodata/g, '')) && !NOTHING.test(text), 'no stringified nothing in any of them');
  /* an older payload renders exactly as before */
  const old = JSON.parse(JSON.stringify(RESEARCH)); delete old.research_view;
  const s0 = P.snapshot({ cards: [], report_type: 'GAME', preset: 'CFB', research: old, event_label: 'x' });
  eq(s0.public.research.research_read, null, 'a payload without the view has no research read');
  lacks(P.briefHTML(s0), 'Research read', 'and no section');
}
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

/* ------------------------------------------------------------------------ */
section('4 · the article: a "Research read" section, and the publication checks');
let ART = null;
{
  const meta = AMODEL.gameMetaFrom(RESEARCH, 'CFB', { home: HOME, away: AWAY, game_id: 'PB1', kickoff: '2026-09-19T23:30:00.000Z' });
  ART = AMODEL.build(RESEARCH, meta, { now: '2026-09-18T12:00:00Z' });
  const art = AMODEL.articleFor(ART);
  const sec = art.sections.filter(x => x.kind === 'research_read')[0];
  ok(!!sec, 'the article has a research-read section');
  eq(sec.label, RESEARCH.research_view.label.label, 'with the view’s label');
  eq(art.sections.map(x => x.kind).indexOf('research_read'), art.sections.map(x => x.kind).indexOf('snapshot') + 1, 'right after the model snapshot');
  ok(sec.cards.some(c => c.k === 'Market gap' && c.v === RESEARCH.research_view.market_gap.points.toFixed(1) + ' pts'
    && c.sub.indexOf('toward ' + RESEARCH.research_view.market_gap.toward_team) === 0), 'the gap card: its size, then its direction and the market');
  ok(sec.cards.some(c => c.k === 'Reliability'), 'and reliability apart from confidence');
  const page = ARENDER.articlePage(Object.assign({}, ART, { article: art }), { noindex: true });
  has(page, 'Research read', 'the rendered page shows it');
  has(page, 'a-rchip k-' + RESEARCH.research_view.label.key.toLowerCase().replace(/[^a-z]+/g, '-'), 'with the label chip');
  has(page, 'Why EdgeDesk leans', 'and the measured reasons');
  const failed = AMODEL.checks(ART).filter(c => !c.ok && /forbidden|nothing|language|null/i.test(c.id + ' ' + c.why));
  eq(failed.length, 0, 'the research view trips no language or stringified-nothing check');
  const oldR = JSON.parse(JSON.stringify(RESEARCH)); delete oldR.research_view;
  ok(!AMODEL.articleFor(AMODEL.build(oldR, meta, { now: '2026-09-18T12:00:00Z' })).sections.some(x => x.kind === 'research_read'),
    'an older record has no such section');
}

/* ------------------------------------------------------------------------ */
section('5 · the snapshot: verbatim, citable, and stable across captures');
let SN = null;
{
  /* the game meta the pipeline itself builds from the payload */
  const meta = AMODEL.gameMetaFrom(RESEARCH, 'CFB', { home: HOME, away: AWAY, game_id: 'PB1', kickoff: '2026-09-19T23:30:00.000Z' });
  SN = SNAP.capture(RESEARCH, meta, { now: '2026-09-18T12:00:00Z' });
  ok(SN.research_view && SN.research_view.contract === 'cfb_research_brief/1', 'the snapshot carries the research view');
  eq(SN.research.research_view.label.key, SN.research_view.label.key, 'the same one the verbatim payload holds');
  const ids = SN.facts.map(f => f.id);
  ['research.label', 'research.gap', 'research.confidence', 'research.reliability', 'research.status'].forEach(id =>
    ok(ids.indexOf(id) >= 0, 'the ledger holds ' + id));
  ok(ids.some(i => /^research\.lean\.\d+$/.test(i)), 'and each measured reason as its own fact');
  eq(SN.facts.filter(f => f.id === 'research.label')[0].value, RESEARCH.research_view.label.label, 'the label fact is the view’s label');
  ok(SNAP.verify(SN).ok, 'the snapshot verifies', SNAP.verify(SN).problems);
  const later = SNAP.capture(RESEARCH, meta, { now: '2026-09-18T15:00:00Z' });
  eq(later.snapshot_id, SN.snapshot_id, 'a later capture of the same research is the same snapshot');
  const tampered = JSON.parse(JSON.stringify(SN)); tampered.research.research_view.label.key = 'MAJOR_DISAGREEMENT';
  eq(SNAP.verify(tampered).ok, false, 'and editing the stored research view is detected');
}

/* ------------------------------------------------------------------------ */
section('6 · the narration: the model is handed the measured reasons');
{
  const rec = { article_type: 'postgame', home_team: HOME, away_team: AWAY, sport_label: 'College Football', snapshot: SN, theses: [], audit: [] };
  const pl = NARRATE.payloadFor(rec);
  ok(pl.research_read && pl.research_read.label === RESEARCH.research_view.label.label, 'the narration payload carries the research read');
  ok(pl.research_read.measured_reasons && Array.isArray(pl.research_read.measured_reasons.reasons), 'with the measured reasons', pl.research_read);
  has(NARRATE.promptFor(rec).system, 'research_read.measured_reasons', 'and the prompt forbids any other reason');
  const sup = QUALITY.supportedValues(rec);
  const gp = String(RESEARCH.research_view.market_gap.points.toFixed(1));
  ok(sup[QUALITY.norm(gp)], 'a gap figure from the read is a supported figure', gp);
  eq(NARRATE.payloadFor({ snapshot: {}, theses: [], audit: [] }).research_read.available, false, 'absent the view, it says so');
}

/* ------------------------------------------------------------------------ */
section('7 · the headless host loads what the brief needs');
{
  const src = fs.readFileSync(path.join(ROOT, 'tools', 'articles', 'research_host.js'), 'utf8');
  has(src, "path.join(ROOT, 'lib', 'cfb_research_view.js')", 'it loads the research view');
  has(src, '/*__EDINTEL_START__*/', 'and the freshness policy the best line is judged by');
  has(src, 'win.fbP4RecordEnsure(win.FB.p4.season)', 'and the model record the history reads');
  has(src, 'win.fbP4LoadGuarded', 'and runs the terminal’s own loader');
  has(BOOT.module, 'window.fbP4RecordEnsure=fbP4RecordEnsure', 'the page exports the record loader');
  has(BOOT.module, 'window.fbP4LoadGuarded=fbP4LoadGuarded', 'and the guarded loader');
}

console.log('\n' + (failures ? failures + ' of ' + checks + ' checks FAILED' : 'all ' + checks + ' checks passed'));
process.exit(failures ? 1 : 0);
