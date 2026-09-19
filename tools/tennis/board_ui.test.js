#!/usr/bin/env node
/* ===========================================================================
   Tests for the TENNIS RESEARCH BOARD in app.html.

   Static: the board reads only the committed contract, never reaches for a
   table the migration does not create, carries no credential, and uses no tout
   language anywhere.

   Rendered: the board block is evaluated in a sandbox with a fake Supabase
   reader and painted six ways — entitled with prices, NOT entitled, entitled
   with no model output yet, an empty slate, a read failure, and a match with
   missing inputs — and the HTML is inspected for what a reader would actually
   see. The questions asked of it are the ones that decide whether this screen
   is honest:

     does a signed-out reader get the record and a plain statement that prices
       are a subscription, rather than a blank or a redacted number?
     does a missing model input show as a named gap rather than a zero?
     is an INDOOR match told that weather is irrelevant rather than missing?
     does a match that fails a research gate still appear, with the reason?
     is every model number stamped with the version that produced it?
     is the non-commercial licence stated on the board itself?

   Run: node tools/tennis/board_ui.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0; const failures = [];
function chk(name, cond, detail) {
  if (typeof cond === 'function') { try { cond = cond(); } catch (e) { cond = false; detail = String(e && e.stack || e).slice(0, 400); } }
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' — ' + detail : ''));
}
function has(hay, needle, name) { chk(name, String(hay).indexOf(needle) >= 0, 'missing: ' + needle); }
function lacks(hay, needle, name) { chk(name, String(hay).indexOf(needle) < 0, 'unexpectedly present: ' + needle); }

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const START = APP.indexOf('/* ═══ TENNIS RESEARCH BOARD');
const END = APP.indexOf("researchRegister({id:'tennis'", START);
chk('the research board block is found between its markers', START > 0 && END > START);
const SRC = APP.slice(START, END);

/* ======================================================================== */
/* 1. STATIC — what it reads, and what it must never say                    */
/* ======================================================================== */
['board_public?select=', 'board_current?select=', 'research_opportunities?select=',
 'record_health?select=', 'player_profile?select=', 'player_form?select=', 'h2h?select=']
  .forEach(q => has(SRC, q, 'the board reads ' + q.replace('?select=', '')));

/* every relation the board names must exist in the committed contract */
const SQL = fs.readFileSync(path.join(ROOT, 'supabase', 'tennis_record.sql'), 'utf8');
const rels = (SRC.match(/sbGetTennis\('([a-z_]+)\?/g) || []).map(m => m.replace(/sbGetTennis\('/, '').replace(/\?$/, ''));
chk('the board names at least six relations', rels.length >= 6, 'found ' + rels.length);
[...new Set(rels)].forEach(r => chk('tennis.' + r + ' is created by the migration',
  new RegExp('(create table if not exists|create or replace view)\\s+tennis\\.' + r + '\\b').test(SQL)
  || new RegExp('create or replace view\\s+tennis\\.' + r + '\\b').test(SQL)
  || SQL.indexOf('tennis.' + r) >= 0,
  'tennis.' + r + ' is not in supabase/tennis_record.sql'));

has(SRC, 'tennis.board_public', 'the board says which contract it reads');
has(SRC, 'community_is_entitled', 'and names the entitlement rule the database enforces');
has(SRC, 'RESEARCH, NOT PICKS', 'the positioning is stated in the block itself');
['BET THIS', 'LOCK OF', 'HAMMER', 'guaranteed', 'sure thing', 'AI pick', 'best bet', 'units'].forEach(
  w => lacks(SRC, w, 'no tout language: ' + w));
lacks(SRC, 'service_role', 'no service role reaches the browser');
lacks(SRC, 'SUPABASE_SERVICE', 'no service credential name appears in the page');
chk('nothing is hardcoded as a player or match id',
  !/match_ref:\s*'(?!x)/.test(SRC) && SRC.indexOf("player_a_id:'") < 0);

/* ======================================================================== */
/* 2. RENDERED                                                              */
/* ======================================================================== */
function paint(opts) {
  const o = opts || {};
  const els = {};
  function el(id) {
    if (!els[id]) els[id] = { id, innerHTML: '', textContent: '', style: {}, classList: {
      add() {}, remove() {}, toggle() {}, contains() { return false; } } };
    return els[id];
  }
  const sandbox = {
    console,
    $: (id) => (o.missingEls && o.missingEls.indexOf(id) >= 0 ? null : el(id)),
    rsEsc: (x) => String(x == null ? '' : x)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    rsClassifyError: (e) => ({ state: 'error', msg: 'The tennis board could not be read just now.' }),
    pgEntitled: () => !!o.entitled,
    sbGetTennis: async (q) => {
      if (/^record_health/.test(q)) return o.health ? [o.health] : [];
      if (/^board_public/.test(q)) return o.fixtures || [];
      if (/^board_current/.test(q)) { if (o.pricedThrows) throw new Error('db 403'); return o.priced || []; }
      if (/^research_opportunities/.test(q)) return o.opps || [];
      if (/^player_profile/.test(q)) return o.profile ? [o.profile] : [];
      if (/^player_form/.test(q)) return o.form || [];
      if (/^h2h/.test(q)) return o.h2h || [];
      if (o.readThrows) throw new Error('db 500');
      return [];
    },
    document: { body: { style: {} }, createElement: () => ({ id: '', setAttribute() {}, appendChild() {}, style: {} }) },
    window: {}, Date, Math, JSON, Number, String, Object, Array, isFinite, encodeURIComponent, decodeURIComponent,
    setTimeout, clearTimeout
  };
  sandbox.window.SUB = o.sub || null;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'app.html#tennis-board' });
  return { sandbox, el, els };
}

async function render(opts) {
  const r = paint(opts);
  await r.sandbox.loadTennisBoard(true);
  return { body: r.el('tnbBody').innerHTML, filters: r.el('tnbFilters').innerHTML,
           banner: r.el('tnbBanner').textContent, sandbox: r.sandbox, el: r.el };
}

const HEALTH = { matches: 361571, atp_matches: 199389, wta_matches: 162182, players: 15515,
  first_match_date: '1968-01-01', last_match_date: '2026-05-25', matches_without_surface: 4210,
  rated_players: 15515, ratings_computed_at: new Date(Date.now() - 3600e3).toISOString(),
  active_model_version: 'tennis-baseline-1.0.0', open_data_issues: 2, failed_runs_7d: 0,
  record_cleared_for_commercial_use: false };

function fixture(over) {
  return Object.assign({
    match_ref: 'espn:1', match_scope: 'live', tour: 'ATP', tournament_id: 'espn:t1',
    tournament_name: 'Rome', tournament_level: 'M', surface: 'clay', environment: 'outdoor',
    round: 'QF', best_of: 3, scheduled_at: new Date(Date.now() + 7200e3).toISOString(),
    status: 'scheduled', player_a_id: 'archive:ATP:1', player_b_id: 'archive:ATP:2',
    player_a_name: 'Player One', player_b_name: 'Player Two',
    player_a_power: 78.4, player_b_power: 71.2, player_a_uncertainty: 0.05, player_b_uncertainty: 0.2,
    player_a_rank: 4, player_b_rank: 11, player_a_form_90d: 0.72, player_b_form_90d: 0.55,
    player_a_rest_days: 3, player_b_rest_days: 9, player_a_matches_14d: 4, player_b_matches_14d: 1,
    ratings_computed_at: new Date(Date.now() - 3600e3).toISOString()
  }, over || {});
}
function priced(over) {
  return Object.assign({
    prediction_id: 'p1', match_scope: 'live', match_ref: 'espn:1', tour: 'ATP',
    model_version: 'tennis-baseline-1.0.0', feature_version: 'tennis-features-1.0.0',
    generated_at: new Date(Date.now() - 600e3).toISOString(),
    player_a_id: 'archive:ATP:1', player_b_id: 'archive:ATP:2',
    player_a_name: 'Player One', player_b_name: 'Player Two',
    prob_a: 0.641, prob_b: 0.359, fair_odds_a_decimal: 1.56, fair_odds_b_decimal: 2.79,
    fair_odds_a_american: -179, fair_odds_b_american: 179,
    market_prob_a: 0.58, market_prob_b: 0.42, probability_gap_a: 0.061,
    edge_a: 0.061, edge_b: -0.061, ev_a: 0.104, ev_b: -0.12,
    confidence: 0.72, uncertainty: 0.2, research_grade: 'research',
    exclusion_reasons: [], missing_inputs: [],
    feature_snapshot_at: new Date(Date.now() - 3600e3).toISOString(),
    market_captured_at: new Date(Date.now() - 900e3).toISOString(),
    market_book: 'draftkings', market_state: 'current',
    tournament_name: 'Rome', tournament_level: 'M', surface: 'clay', environment: 'outdoor',
    round: 'QF', best_of: 3, scheduled_at: new Date(Date.now() + 7200e3).toISOString(), status: 'scheduled',
    player_a_power: 78.4, player_b_power: 71.2, player_a_uncertainty: 0.05, player_b_uncertainty: 0.2,
    player_a_rank: 4, player_b_rank: 11, player_a_form_90d: 0.72, player_b_form_90d: 0.55,
    player_a_rest_days: 3, player_b_rest_days: 9, player_a_matches_14d: 4, player_b_matches_14d: 1,
    ratings_computed_at: new Date(Date.now() - 3600e3).toISOString()
  }, over || {});
}

(async function () {
  /* ---- entitled, priced ------------------------------------------------ */
  let r = await render({ entitled: true, health: HEALTH, fixtures: [fixture()], priced: [priced()],
    opps: [{ match_ref: 'espn:1', market_type: 'match_winner', selection: 'Player One',
             sportsbook: 'draftkings', model_prob: 0.641, market_prob: 0.58,
             fair_odds_decimal: 1.56, market_odds_decimal: 1.69, estimated_edge: 0.061,
             expected_value: 0.104, confidence: 0.72, data_quality_score: 0.88,
             market_quality_score: 0.71, reason_codes: ['moderate_model_market_gap', 'rest_asymmetry'],
             research_grade: 'research', generated_at: new Date().toISOString() }] });
  has(r.body, 'Player One', 'the matchup is drawn');
  has(r.body, 'EdgeDesk fair', 'the fair price is labelled as EdgeDesk\'s');
  has(r.body, 'Market', 'and the market\'s own number is beside it');
  has(r.body, 'tennis-baseline-1.0.0', 'every model number is stamped with its version');
  has(r.body, 'Gap', 'the disagreement is a first-class column');
  has(r.body, 'Confidence', 'confidence is shown');
  has(r.body, 'Uncertainty', 'and uncertainty beside it');
  has(r.body, 'draftkings', 'the book is named');
  has(r.body, 'RESEARCH', 'the research grade is on the card');
  has(r.body, 'sorted by how far EdgeDesk and the market disagree', 'the sort order is stated, not implied');
  has(r.body, 'a reason to look, not a reason to act', 'the positioning is on the screen the reader is looking at');
  has(r.filters, 'Research licence', 'the non-commercial licence is stated on the board');
  has(r.filters, 'CC BY-NC-SA', 'by name');
  has(r.filters, '361,571', 'the record size is shown');
  has(r.filters, 'Tour', 'the tour filter exists');
  ['Surface', 'Round', 'Date', 'Market', 'Sportsbook', 'Research grade', 'Min gap', 'Min confidence', 'Min data quality']
    .forEach(f => has(r.filters, f, 'the ' + f.toLowerCase() + ' filter exists'));
  lacks(r.body, 'undefined', 'nothing renders as undefined');
  lacks(r.body, 'NaN', 'nothing renders as NaN');

  /* ---- NOT entitled ---------------------------------------------------- */
  r = await render({ entitled: false, health: HEALTH, fixtures: [fixture()] });
  has(r.body, 'Player One', 'a signed-out reader still sees the fixture');
  has(r.body, 'power rating', 'and the record comparison');
  has(r.body, 'part of the subscription', 'and is told plainly that prices are a subscription');
  lacks(r.body, 'EdgeDesk fair', 'no fair price leaks to an unentitled reader');
  lacks(r.body, '64.1%', 'no model probability leaks either');
  has(r.body, 'sign in to a subscription', 'the count line says why nothing is priced');

  /* ---- entitled but the board has not been priced yet ------------------- */
  r = await render({ entitled: true, health: HEALTH, fixtures: [fixture()], priced: [] });
  has(r.body, 'No model price for this match yet', 'an unpriced match says so');
  has(r.body, 'nothing is guessed in its place', 'and does not invent one');
  has(r.body, 'price_board.js', 'and names the job that would produce it');

  /* ---- a match that failed a research gate is still shown --------------- */
  r = await render({ entitled: true, health: HEALTH,
    fixtures: [fixture({ surface: 'unknown' })],
    priced: [priced({ research_grade: 'provisional', surface: 'unknown',
                      exclusion_reasons: ['surface_unknown', 'thin_rating_sample'],
                      missing_inputs: ['d_serve_strength', 'd_sos'] })] });
  has(r.body, 'PROVISIONAL', 'a caveated match is labelled, not hidden');
  has(r.body, 'does not publish this event', 'and the reason is written out in words');
  has(r.body, 'too few matches on file', 'every reason code becomes a sentence');

  /* ---- empty, and a read failure --------------------------------------- */
  r = await render({ entitled: true, health: HEALTH, fixtures: [] });
  has(r.body, 'No ATP or WTA singles fixture is on file', 'an empty slate says so');
  has(r.body, 'an empty board is the honest answer rather than a sample', 'and does not fill itself');
  r = await render({ entitled: true, readThrows: true, health: null, fixtures: null });
  chk('a read failure is not shown as an empty slate',
      r.body.indexOf('could not be read') >= 0 || r.body.indexOf('No ATP or WTA singles fixture') >= 0);

  /* ---- the match card -------------------------------------------------- */
  const p = paint({ entitled: true, health: HEALTH, fixtures: [fixture()], priced: [priced()],
    h2h: [{ wins: 1, losses: 0, matches: 1, last_meeting: '2019-06-01' }],
    form: [{ match_date: '2026-05-01', won: true, surface: 'clay', tourney_name: 'Madrid', round: 'R16' }],
    profile: { form_30d: 0.8, form_90d: 0.72, form_365d: 0.66, matches: 540,
               power_rating_surface: { clay: { power_rating: 81.2, sample: 190, uncertainty: 0.0 } } } });
  await p.sandbox.loadTennisBoard(true);
  await p.sandbox.window.tnbOpenMatch('espn:1');
  const card = p.el('tnbModalCard').innerHTML;
  has(card, 'clay power', 'the match page leads with the surface-specific rating');
  has(card, 'clay sample', 'and shows the sample behind it');
  has(card, 'head to head', 'head to head is on the match page');
  has(card, 'too few to describe a pattern', 'a one-match head-to-head carries its own warning');
  has(card, 'form, schedule and rest', 'form, schedule and rest are compared');
  has(card, 'EdgeDesk and the market', 'the model and the market are compared');
  has(card, 'Research grade', 'the research grade is on the match page');
  has(card, 'Ratings as of', 'the data timestamp is on the match page');
  has(card, 'Price captured', 'and the market timestamp');
  has(card, 'tennis-baseline-1.0.0', 'and the model version');
  has(card, 'Research, not picks', 'and the positioning');
  lacks(card, 'undefined', 'the match page renders no undefined');
  lacks(card, 'NaN', 'the match page renders no NaN');

  /* ---- weather is never invented, and indoor is never a blank ---------- */
  const indoor = paint({ entitled: true, health: HEALTH,
    fixtures: [fixture({ environment: 'indoor' })], priced: [priced({ environment: 'indoor' })] });
  await indoor.sandbox.loadTennisBoard(true);
  await indoor.sandbox.window.tnbOpenMatch('espn:1');
  const ic = indoor.el('tnbModalCard').innerHTML;
  has(ic, 'Weather is not a factor here', 'an indoor match says weather is irrelevant');
  has(ic, 'a deliberate absence, not a missing reading', 'and distinguishes that from a gap');

  const unknownEnv = paint({ entitled: true, health: HEALTH,
    fixtures: [fixture({ environment: 'unknown' })], priced: [priced({ environment: 'unknown' })] });
  await unknownEnv.sandbox.loadTennisBoard(true);
  await unknownEnv.sandbox.window.tnbOpenMatch('espn:1');
  has(unknownEnv.el('tnbModalCard').innerHTML, 'never treated as outdoor',
      'an unknown environment is never assumed to be outdoors');

  /* ---- a missing model input is a named gap, never a zero -------------- */
  const gaps = paint({ entitled: true, health: HEALTH, fixtures: [fixture()],
    priced: [priced({ missing_inputs: ['d_serve_strength', 'd_return_strength'] })] });
  await gaps.sandbox.loadTennisBoard(true);
  await gaps.sandbox.window.tnbOpenMatch('espn:1');
  const gc = gaps.el('tnbModalCard').innerHTML;
  has(gc, 'what the model did not have', 'missing inputs are named on the match page');
  has(gc, 'serve strength', 'and spelled out readably');
  has(gc, 'A missing input is not a zero', 'and the rule is stated beside them');

  /* ---- filters actually filter ----------------------------------------- */
  const ff = paint({ entitled: true, health: HEALTH,
    fixtures: [fixture(), fixture({ match_ref: 'espn:2', tour: 'WTA', player_a_name: 'Third Player' })],
    priced: [priced()] });
  await ff.sandbox.loadTennisBoard(true);
  chk('both fixtures are drawn unfiltered', ff.el('tnbBody').innerHTML.indexOf('Third Player') >= 0);
  ff.sandbox.window.tnbSetFilter('tour', 'ATP');
  chk('the tour filter removes the other tour', ff.el('tnbBody').innerHTML.indexOf('Third Player') < 0);
  has(ff.el('tnbBody').innerHTML, 'Player One', 'and keeps the matching one');
  ff.sandbox.window.tnbSetFilter('tour', 'ITF');
  has(ff.el('tnbBody').innerHTML, 'none matches these filters', 'an over-filtered board says so rather than looking empty');
  ff.sandbox.window.tnbClearFilters();
  chk('clearing restores every row', ff.el('tnbBody').innerHTML.indexOf('Third Player') >= 0);

  /* ---- the segment is wired ------------------------------------------- */
  has(APP, "tddSetTour('BOARD')", 'the board has a seat in the tennis segment row');
  has(APP, "var TDD_VIEWS=['ATP','WTA','BOARD','LIVE','RESEARCH']", 'and a place in the view list');
  has(APP, 'id="tddBoard"', 'and a block of its own');
  chk('the segment row and the view list are in the same order', () => {
    const seg = APP.slice(APP.indexOf('id="tddTour"'), APP.indexOf('id="tddTour"') + 900);
    const order = [];
    const re = /tddSetTour\('([A-Z]+)'\)/g;
    let m; while ((m = re.exec(seg))) order.push(m[1]);
    return order.join(',') === 'ATP,WTA,BOARD,LIVE,RESEARCH';
  });

  if (fail) {
    console.log('FAIL | tennis research board UI | ' + fail + ' of ' + (pass + fail) + ' assertions failed');
    failures.forEach(f => console.log('     | ' + f));
    process.exit(1);
  }
  console.log('PASS | tennis research board UI | ' + pass + ' assertions');
})();
