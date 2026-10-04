#!/usr/bin/env node
/* ===========================================================================
   CASE 27 — AN UNQUALIFIED ROW WITH edge > 0 MUST NOT RENDER AS AN EDGE.

   This is the test the whole overhaul exists for, and it belongs to the READER,
   not to capture. Capture can refuse to flag a price; it cannot stop a query
   from selecting one. Every place that turned out to be doing so is asserted
   here, against the real app.html and the real edgedesk_ai — sliced out of the
   deployed files, never a copy, so a regression fails here rather than on a
   board somebody is reading.

   THE CANONICAL DEFINITION, stated once:
     A row is an actionable EdgeDesk signal if and only if
       flagged_at IS NOT NULL AND flagged_best_dec > 1
     which capture writes only when qualifySignal() returns actionable.
   Everything else is a stored market observation. It may be shown as market
   data. It may not be shown as an Edge.

   Run: node tools/capture/board_contract.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function done() {
  failures.forEach(function (f) {
    console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 700) : ''));
  });
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const ROOT = path.join(__dirname, '..', '..');

/* The edge function is Deno code imported under Node's native type stripping.
   The shim goes in before the import, and it deliberately answers nothing —
   this suite constructs the Dal with its OWN fetch, so the module must not be
   able to reach anything on its own. */
globalThis.Deno = globalThis.Deno || { env: { get: function (k) {
  return ({ EDGEDESK_AI_NO_SERVE: '1', SUPABASE_URL: 'https://sb.invalid',
    SUPABASE_ANON_KEY: 'k', ANTHROPIC_API_KEY: 'k' })[k];
} } };
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const AI = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts'), 'utf8');

/** Cut a literal region out of the real file, failing loudly if it moved. */
function slice(src, start, end, label) {
  const a = src.indexOf(start);
  if (a < 0) throw new Error('could not find the start of ' + label + ' — it moved, so this test was testing nothing');
  const b = src.indexOf(end, a);
  if (b < 0) throw new Error('could not find the end of ' + label);
  return src.slice(a, b + end.length);
}

(async function main() {
  /* ── 1. THE PREDICATE ITSELF, RUN ─────────────────────────────────────── */
  const guardSrc = slice(APP,
    'function wasFlaggedSignal(e){', 'function hasQualState(e){ return !!(e && (e.qual_reason!=null || e.actionable!=null)); }',
    'the predicate block');
  const ctx = { console: console };
  vm.createContext(ctx);
  vm.runInContext("function edBool(v){ return v===true||v==='true'||v===1||v==='1'||v==='t'; }\n" + guardSrc, ctx);

  const flagged = { event_id: 'e1', market: 'spreads', selection: 'A', point: -3.5, flagged_at: '2026-09-05T10:00:00Z', flagged_best_dec: 1.95, edge: 0.03 };
  const stored = { event_id: 'e2', market: 'spreads', selection: 'B', point: -3.5, flagged_at: null, flagged_best_dec: null, edge: 5.05 };
  const halfFlagged = { event_id: 'e3', market: 'h2h', selection: 'C', point: null, flagged_at: '2026-09-05T10:00:00Z', flagged_best_dec: null, edge: 0.4 };
  const brokenEntry = { event_id: 'e4', market: 'h2h', selection: 'D', point: null, flagged_at: '2026-09-05T10:00:00Z', flagged_best_dec: 1, edge: 0.4 };

  chk('a qualified row with a frozen entry is a signal', ctx.isFlaggedSignal(flagged) === true);
  chk('27 · a STORED row with a +505% edge is NOT a signal', ctx.isFlaggedSignal(stored) === false);
  chk('a flag without a frozen entry price is not a signal', ctx.isFlaggedSignal(halfFlagged) === false);
  chk('a frozen entry of 1.0 is not a price', ctx.isFlaggedSignal(brokenEntry) === false);
  chk('onlyFlagged keeps exactly the qualified rows',
    ctx.onlyFlagged([flagged, stored, halfFlagged]).length === 1);
  chk('onlyFlagged survives null and undefined', ctx.onlyFlagged(null).length === 0);

  /* ── 2. THE PUBLISHER POOL CARRIES THE SAME RULE ──────────────────────── */
  /* It is spelled out separately because its block is loaded standalone by
     tools/presentation/app_presentation.test.js. Spelled out means it can drift,
     so this asserts it has not. */
  const poolSrc = slice(APP, '  function pool(){', '    return out;\n  }', 'the publisher pool');
  const actionableRow = Object.assign({}, flagged, { actionable: true, qual_reason: 'ok', qual_tier: 'A' });
  const pctx = { console: console, window: { EDGES: [actionableRow, stored], D5_POOL: [halfFlagged] } };
  vm.createContext(pctx);
  vm.runInContext(poolSrc + '\nthis.__pool = pool;', pctx);
  const pooled = pctx.__pool();
  chk('the publisher pool admits only CURRENTLY actionable signals', pooled.length === 1 && pooled[0].qual_reason === 'ok', pooled);
  chk('the publisher predicate is the CURRENT rule, not the frozen anchor',
    /e\.actionable===true\|\|e\.actionable==='true'/.test(poolSrc) && /qual_reason==='ok'/.test(poolSrc),
    poolSrc.slice(0, 500));

  /* ── 3. THE BETTABLE BOARD IS GATED; THE RESEARCH POOLS ARE NOT ────────
     One query decides what is bettable and it carries the filter. The other two
     are RESEARCH pools whose whole job is to still show the slate on a day when
     capture qualifies nothing — gating them made every surface blank at once,
     which reads to a user exactly like a broken terminal. They are safe not
     because they are filtered but because their render paths LABEL: every row
     goes through canonicalMarketVerdict(), which cannot return BET for a row
     capture refused. Seeing is not betting. */
  {
    const i = APP.indexOf("var _edgesFetched=await sbGet('signals?select=");
    chk('the bettable board query is present', i >= 0);
    const line = APP.slice(i, APP.indexOf('\n', i));
    chk('the bettable board filters on CURRENT actionability server-side',
      line.indexOf('BOARD_ACTIVE_FILTER') >= 0, line.slice(0, 260));
    chk('and again in memory, because a URL predicate does not survive a concat',
      APP.indexOf('var _et=filterTradeable(onlyActionable(EDGES));') >= 0);
  }

  [['the ranking pool behind the Top 5',
    "try{var pool=await sbGet('signals?select=event_id,sport_title,sport_key,market,selection,point,best_dec,first_best_dec,sharp_fair,best_book"],
   ['the consensus-engine pool', "try{var cq=await sbGet('signals?select="],
  ].forEach(function (qd) {
    const i = APP.indexOf(qd[1]);
    chk('research pool query is present: ' + qd[0], i >= 0);
    if (i < 0) return;
    const line = APP.slice(i, APP.indexOf('\n', i));
    chk(qd[0] + ' is NOT gated on actionability — it must survive an empty board',
      line.indexOf('BOARD_ACTIVE_FILTER') < 0, line.slice(0, 260));
    chk(qd[0] + ' still carries the qualification columns, so it can label each row',
      line.indexOf('BOARD_FLAG_COLS') >= 0, line.slice(0, 260));
  });

  chk('the research pools are no longer filtered down to actionable in memory',
    APP.indexOf('var ft=filterTradeable(onlyActionable(pool));') < 0
    && APP.indexOf('window.CONS_POOL=filterTradeable(onlyActionable(cq)).keep;') < 0);
  chk('they are still filtered for TRADEABILITY — an exchange lay is not a price',
    APP.indexOf('var ft=filterTradeable(pool||[]);') >= 0
    && APP.indexOf('window.CONS_POOL=filterTradeable(cq||[]).keep;') >= 0);

  /* ── 4. THE CONCATENATED POOLS ────────────────────────────────────────── */
  /* The contract says a pool built by concatenation must re-assert the rule.
     These four are the ones a user's answer actually comes out of. */
  [['bestBets — "what are the best opportunities today?"',
    "var pool=onlyActionable([].concat(window.EDGES||[], window.D5_POOL||[]));"],
   ['compare — the ranked head-to-head',
    "var pool=onlyActionable([].concat(window.EDGES||[],window.D5_POOL||[]))"],
  ].forEach(function (c) {
    chk('concatenated pool re-asserts the rule: ' + c[0], APP.indexOf(c[1]) >= 0, c[1]);
  });

  /* ── 5. THE UNGATED SURFACES MUST LABEL THEMSELVES ────────────────────── */
  /* Two reads are deliberately NOT flag-gated, and both are defensible: the
     near-miss line exists to prove the scan ran, and the model-overlay backfill
     exists to put a market price beside a model number on a game with no
     EdgeDesk signal. Neither may present its number as an Edge. */
  const nearMiss = slice(APP, 'var nmWhy=', '</div>\';', 'the near-miss line');
  chk('the near-miss line says outright that it is not a signal',
    /not an EdgeDesk signal/.test(nearMiss), nearMiss.slice(0, 300));
  chk('the near-miss line calls the number a raw gap, not an edge',
    /raw gap/.test(nearMiss) && !/best edge/.test(nearMiss));
  chk('and it names the rule that refused it',
    /Why it is not on the board/.test(nearMiss) && /QUAL_REASON_TEXT/.test(nearMiss));
  chk('the near-miss query selects the qualification state it needs to say that',
    /qual_reason,qual_tier,reference_type/.test(APP));

  const overlay = slice(APP, "      (sig&&sig.edge!=null\n", "        : '');", 'the model-overlay market line');
  chk('the model overlay branches on CURRENT actionability, not the frozen anchor',
    /isActionableSignal\(sig\)/.test(overlay) && !/isFlaggedSignal\(sig\)/.test(overlay),
    overlay.slice(0, 200));
  chk('a qualified row is labelled an EdgeDesk signal', /EdgeDesk signal on this line/.test(overlay));
  chk('27 · an UNqualified row is labelled a raw price gap, not a MARKET edge',
    /not an EdgeDesk signal/.test(overlay) && !/MARKET edge on this line/.test(APP), overlay.slice(0, 400));

  /* ── 6. THE PULSE BOARD ───────────────────────────────────────────────── */
  const pulse = slice(APP, "  var rows=await sbGet('signals?select=event_id,sport_title,sport_key,home_team,away_team,commence_time,edge,",
    'var out=[];for(var k in m)out.push(m[k]);', 'the Pulse room board');
  chk('the Pulse "best edge" chip is computed from actionable rows only',
    /if\(!isActionableSignal\(r\)\)return;/.test(pulse), pulse.slice(0, 500));
  chk('but its markets-priced coverage count still sees everything',
    pulse.indexOf('e.mkts++') < pulse.indexOf('if(!isActionableSignal(r))return;'), 'coverage must be counted before the claim is gated');

  /* ── 7. THE SERVER-SIDE BOARD ─────────────────────────────────────────── */
  chk('edgedesk_ai exports the canonical predicate', /export function signalIsActionable/.test(AI));
  chk('the engine predicate is the SAME rule as the app\'s',
    /r\.flagged_at && Number\.isFinite\(Number\(r\.flagged_best_dec\)\) && Number\(r\.flagged_best_dec\) > 1/.test(AI));
  /* ── THE SERVER BOARD, RUN RATHER THAN READ ────────────────────────────
     These assertions used to be regexes over a region SLICED OUT OF THE
     TYPESCRIPT SOURCE by literal start and end markers. That mechanism is
     brittle by construction: it broke the moment `const out = rows.map((r) =>
     ev({` became a block body, and it broke LOUDLY but for the wrong reason —
     the contract it guards had not changed at all.

     The contract is behavioural, so it is tested behaviourally now: the real
     Dal is constructed with a mocked fetch, the real method is called, and the
     assertions read the REQUEST IT MADE and the EVIDENCE IT RETURNED. That is
     strictly stronger than matching source text — a refactor that preserves
     behaviour passes, and one that quietly drops the flag filter fails even if
     the source still contains the string. */
  const AIMOD = await import(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', 'index.ts'));
  chk('edgedesk_ai exports the Dal so its contract can be run, not just read', typeof AIMOD.Dal === 'function');

  /** Call a Dal method against fixed rows; return what it asked for and got. */
  async function runDal(rows, fn) {
    const asked = [];
    const fetchImpl = async function (url, init) {
      asked.push(String(url));
      if (init && init.method === 'HEAD') return { ok: true, status: 200, headers: { get: () => '*/0' }, text: async () => '' };
      const body = JSON.stringify(rows);
      return { ok: true, status: 200, text: async () => body, json: async () => rows };
    };
    AIMOD.clearCache();
    const dal = new AIMOD.Dal({ supabaseUrl: 'https://sb.test', apikey: 'k',
      authorization: 'Bearer board-contract-' + Math.random(), budget: 40, fetchImpl: fetchImpl });
    const out = await fn(dal);
    return { asked: asked, out: out };
  }

  const NOW = Date.now();
  /* One qualified signal and one stored observation with a positive edge and
     no flag — the exact pair this whole case exists for. */
  const QUALIFIED = {
    event_id: 'ev-q', sport_key: 'americanfootball_ncaaf', market: 'spreads', selection: 'North Texas',
    point: -2.5, best_dec: 1.95, first_best_dec: 1.91, best_book: 'DraftKings',
    sharp_fair: 0.532, sharp_book_fair: 0.532, consensus_fair: 0.528,
    reference_type: 'sharp', reference_book: 'pinnacle', pin_dec: 1.88, pin_opp_dec: 2.02,
    edge: 0.037, first_edge: 0.016, n_books: 9, n_books_eff: 6, has_sharp: true, corrob_n: 2,
    flagged_at: new Date(NOW - 5 * 60000).toISOString(), flagged_best_dec: 1.91,
    home_team: 'Texas State', away_team: 'North Texas',
    commence_time: new Date(NOW + 3 * 86400000).toISOString(),
    last_seen_at: new Date(NOW - 5 * 60000).toISOString(),
  };
  const UNQUALIFIED = Object.assign({}, QUALIFIED, {
    event_id: 'ev-u', selection: 'Texas State', flagged_at: null, flagged_best_dec: null, edge: 0.04,
  });
  const STALE = Object.assign({}, QUALIFIED, {
    event_id: 'ev-s', selection: 'Stale Side',
    last_seen_at: new Date(NOW - 2126 * 60000).toISOString(),
  });

  {
    const r = await runDal([QUALIFIED, UNQUALIFIED, STALE], (d) => d.getSlate('americanfootball_ncaaf'));
    const url = r.asked.find(function (u) { return u.indexOf('signals?') >= 0; }) || '';
    chk('27 · getSlate — "the board, server-side" — filters on the flag in the QUERY it actually sends',
      url.indexOf('flagged_at=not.is.null') >= 0 && url.indexOf('flagged_best_dec=not.is.null') >= 0, url.slice(0, 300));

    const sigs = r.out.ev.filter(function (e) { return e.field === 'signal'; });
    chk('getSlate re-checks each row and drops the unflagged one even when the query returns it',
      !sigs.some(function (e) { return e.value && e.value.event_id === 'ev-u'; }),
      sigs.map(function (e) { return e.value && e.value.event_id; }));
    chk('and it says how many it dropped rather than deleting them silently',
      r.out.ev.some(function (e) { return e.field === 'slate_filtered'; }));

    /* THE ANCHOR AND THE CLOCK TRAVEL WITH EVERY BOARD ROW.
       A raw signal row carries `sharp_fair`, which capture fills from the
       CONSENSUS whenever no reference book quotes — so handing the row to the
       model unannotated is how one selection came to claim a Pinnacle anchor
       and deny sharp confirmation in the same answer. */
    const q = sigs.find(function (e) { return e.value && e.value.event_id === 'ev-q'; });
    chk('27 · every board row carries the METHOD that produced its fair price',
      q && q.value.fair_method === 'SHARP_REFERENCE_DEVIG', q && q.value.fair_method);
    chk('and the honest label, which only fairMethod can produce',
      q && /Pinnacle de-vig fair/.test(q.value.fair_label), q && q.value.fair_label);
    chk('and its own quote age and whether that age still permits an action',
      q && q.value.quote_age_min != null && q.value.quote_actionable === true, q && q.value);

    const st = sigs.find(function (e) { return e.value && e.value.event_id === 'ev-s'; });
    chk('a row whose quote is past its limit is marked NOT actionable',
      st && st.value.quote_actionable === false && st.value.quote_status === 'STALE', st && st.value.quote_status);
    chk('and says so in the note the model reads',
      st && /This price is NOT actionable/.test(st.note || ''), st && st.note);
  }

  {
    /* A consensus-anchored row must never come back wearing the word Pinnacle,
       whatever `sharp_fair` holds. */
    const CONSENSUS = Object.assign({}, QUALIFIED, {
      event_id: 'ev-c', sharp_book_fair: null, reference_type: 'robust_consensus',
      reference_book: null, has_sharp: false, pin_dec: null, pin_opp_dec: null,
    });
    const r = await runDal([CONSENSUS], (d) => d.getSlate('americanfootball_ncaaf'));
    const c = r.out.ev.filter(function (e) { return e.field === 'signal'; })[0];
    chk('27 · a consensus fair line is never labelled with a reference book it did not have',
      c && c.value.fair_method === 'ROBUST_CONSENSUS_MEDIAN'
      && String(c.value.fair_label).toLowerCase().indexOf('pinnacle') < 0, c && c.value.fair_label);
    chk('and the row says the fair price rests on softer books',
      c && /No sharp reference quoted it/.test(c.note || ''), c && c.note);
  }

  {
    const r = await runDal([QUALIFIED, UNQUALIFIED], (d) => d.getCrossMarket('ev-q'));
    const cm = r.out.ev.filter(function (e) { return e.field === 'cross_market'; })[0];
    const rows = (cm && cm.value) || [];
    const u = rows.filter(function (x) { return x.edgedesk_signal === false; })[0];
    chk('27 · getCrossMarket nulls the edge on any row that is not a signal',
      !!u && u.edge === null, rows);
    chk('and it tells the model why, rather than just removing the number',
      !!u && !!u.not_a_signal_because, u);
  }
  chk('the engine\'s lay-market rule matches capture\'s _lay SEGMENT rule',
    /\(\^\|_\)lay\(_\|\$\)/.test(AI));

  /* ── 7b. THE MODEL IS NOT TOLD A CONSENSUS IS SHARP ───────────────────── */
  const detCtx = slice(AI, '    deterministic_context: focus', '      : null,', 'deterministic_context');
  chk('the model-facing context carries reference_type alongside sharp_fair',
    /reference_type: focus\.reference_type/.test(detCtx), detCtx.slice(0, 400));
  chk('and sharp_book_fair, which is NULL when there was no reference book',
    /sharp_book_fair: focus\.sharp_book_fair/.test(detCtx));
  chk('the note tells the model to read reference_type before calling it sharp',
    /read `reference_type` before calling it sharp/.test(detCtx), detCtx.slice(-500));
  chk('and forbids describing a robust_consensus as a Pinnacle line',
    /do not describe it as a sharp or Pinnacle line/.test(detCtx));
  chk('the plain-facts block names the KIND of fair line it is passing on',
    /fair_price_source/.test(AI));

  /* ── 7c. A SIGNAL WHOSE EDGE HAS GONE IS NOT A CANDIDATE ────────────────
     Run, not read: a board on which every qualified row has decayed to a
     non-positive edge must say so rather than promoting its least-negative
     row, and the decayed rows must survive as context. */
  {
    const GONE = Object.assign({}, QUALIFIED, { event_id: 'ev-g1', edge: -0.004 });
    const GONE2 = Object.assign({}, QUALIFIED, { event_id: 'ev-g2', selection: 'Other', edge: -0.02 });
    const r = await runDal([GONE, GONE2], (d) => d.getSlate('americanfootball_ncaaf'));
    const note = r.out.ev.map(function (e) { return String(e.note || ''); }).join(' ')
      + ' ' + JSON.stringify(r.out.ev.map(function (e) { return e.value; }));
    chk('getSlate refuses to promote a non-positive-edge row to candidate',
      /every one has moved to a non-positive edge/.test(note), note.slice(0, 400));
    chk('but keeps those rows as context rather than deleting them',
      r.out.rows.length === 2 && r.out.rows.every(function (x) { return x.edge_still_positive === false; }),
      r.out.rows.map(function (x) { return [x.event_id, x.edge_still_positive]; }));
  }

  /* ── 8. THE RECORD MUST NOT WIDEN ITSELF INTO THE STORED POPULATION ───── */
  chk('the record pool is anchored on the flag, not on a live edge band',
    APP.indexOf("var FLAG_STRICT='flagged_at=not.is.null&flagged_edge=gte.0.005&flagged_edge=lte.0.1';") >= 0);
  chk('the record can segment by the policy that produced each signal',
    /flagged_policy/.test(APP), 'app.html must be able to separate v9 signals from legacy ones');

  done();
})().catch(function (e) { console.error('CRASH', (e && e.stack) || e); process.exit(1); });
