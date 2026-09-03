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

(function main() {
  /* ── 1. THE PREDICATE ITSELF, RUN ─────────────────────────────────────── */
  const guardSrc = slice(APP,
    'function isFlaggedSignal(e){', 'function onlyFlagged(rows){ return (rows||[]).filter(isFlaggedSignal); }',
    'the flag predicate');
  const ctx = { console: console };
  vm.createContext(ctx);
  vm.runInContext(guardSrc, ctx);

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
  const pctx = { console: console, window: { EDGES: [flagged, stored], D5_POOL: [halfFlagged] } };
  vm.createContext(pctx);
  vm.runInContext(poolSrc + '\nthis.__pool = pool;', pctx);
  const pooled = pctx.__pool();
  chk('the publisher pool admits only qualified signals', pooled.length === 1 && pooled[0].flagged_best_dec === 1.95, pooled);
  chk('the publisher predicate is the same rule as isFlaggedSignal',
    /flagged_at\s*&&\s*isFinite\(\+e\.flagged_best_dec\)\s*&&\s*\+e\.flagged_best_dec\s*>\s*1/.test(poolSrc), poolSrc.slice(0, 400));

  /* ── 3. EVERY ACTIVE-BOARD QUERY CARRIES THE FILTER ───────────────────── */
  const boardQueries = [
    ['the Top Edges board', "var _edgesFetched=await sbGet('signals?select="],
    ['the ranking pool behind the Top 5', 'try{var pool=await sbGet(\'signals?select=event_id,sport_title,sport_key,market,selection,point,best_dec,first_best_dec,sharp_fair,best_book'],
    ['the consensus-engine pool', "try{var cq=await sbGet('signals?select="],
  ];
  boardQueries.forEach(function (qd) {
    const i = APP.indexOf(qd[1]);
    chk('active-board query is present: ' + qd[0], i >= 0);
    if (i < 0) return;
    const line = APP.slice(i, APP.indexOf('\n', i));
    chk(qd[0] + ' filters on the flag server-side', line.indexOf('BOARD_FLAG_FILTER') >= 0, line.slice(0, 260));
  });

  /* And each is ALSO filtered in memory, because a URL predicate does not
     survive a [].concat() and several pools are built that way. */
  ['var _et=filterTradeable(onlyFlagged(EDGES));',
   'var ft=filterTradeable(onlyFlagged(pool));',
   'window.CONS_POOL=filterTradeable(onlyFlagged(cq)).keep;',
  ].forEach(function (needle) {
    chk('in-memory guard present: ' + needle.slice(0, 46), APP.indexOf(needle) >= 0, needle);
  });

  /* ── 4. THE CONCATENATED POOLS ────────────────────────────────────────── */
  /* The contract says a pool built by concatenation must re-assert the rule.
     These four are the ones a user's answer actually comes out of. */
  [['bestBets — "what are the best opportunities today?"',
    "var pool=onlyFlagged([].concat(window.EDGES||[], window.D5_POOL||[]));"],
   ['compare — the ranked head-to-head',
    "var pool=onlyFlagged([].concat(window.EDGES||[],window.D5_POOL||[]))"],
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
  chk('the model overlay branches on the canonical predicate',
    /isFlaggedSignal\(sig\)/.test(overlay), overlay.slice(0, 200));
  chk('a qualified row is labelled an EdgeDesk signal', /EdgeDesk signal on this line/.test(overlay));
  chk('27 · an UNqualified row is labelled a raw price gap, not a MARKET edge',
    /not an EdgeDesk signal/.test(overlay) && !/MARKET edge on this line/.test(APP), overlay.slice(0, 400));

  /* ── 6. THE PULSE BOARD ───────────────────────────────────────────────── */
  const pulse = slice(APP, "  var rows=await sbGet('signals?select=event_id,sport_title,sport_key,home_team,away_team,commence_time,edge,",
    'var out=[];for(var k in m)out.push(m[k]);', 'the Pulse room board');
  chk('the Pulse "best edge" chip is computed from qualified rows only',
    /if\(!isFlaggedSignal\(r\)\)return;/.test(pulse), pulse.slice(0, 500));
  chk('but its markets-priced coverage count still sees everything',
    pulse.indexOf('e.mkts++') < pulse.indexOf('if(!isFlaggedSignal(r))return;'), 'coverage must be counted before the claim is gated');

  /* ── 7. THE SERVER-SIDE BOARD ─────────────────────────────────────────── */
  chk('edgedesk_ai exports the canonical predicate', /export function signalIsActionable/.test(AI));
  chk('the engine predicate is the SAME rule as the app\'s',
    /r\.flagged_at && Number\.isFinite\(Number\(r\.flagged_best_dec\)\) && Number\(r\.flagged_best_dec\) > 1/.test(AI));
  const slateQ = slice(AI, 'async getSlate(', 'const out = rows.map((r) => ev({', 'getSlate');
  chk('27 · getSlate — "the board, server-side" — filters on the flag in the QUERY',
    /flagged_at=not\.is\.null&flagged_best_dec=not\.is\.null/.test(slateQ), slateQ.slice(0, 600));
  chk('getSlate also re-checks each row before calling it evidence',
    /signalIsActionable\(r\)/.test(slateQ));
  const cross = slice(AI, 'async getCrossMarket(', 'freshness: freshnessOf("odds", marked[0]?.last_seen_at),', 'getCrossMarket');
  chk('27 · getCrossMarket nulls the edge on any row that is not a signal',
    /edgedesk_signal: false, edge: null/.test(cross), cross.slice(0, 800));
  chk('and it tells the model why, rather than just removing the number',
    /not_a_signal_because/.test(cross));
  chk('the engine\'s lay-market rule matches capture\'s _lay SEGMENT rule',
    /\(\^\|_\)lay\(_\|\$\)/.test(AI));

  /* ── 8. THE RECORD MUST NOT WIDEN ITSELF INTO THE STORED POPULATION ───── */
  chk('the record pool is anchored on the flag, not on a live edge band',
    APP.indexOf("var FLAG_STRICT='flagged_at=not.is.null&flagged_edge=gte.0.005&flagged_edge=lte.0.1';") >= 0);
  chk('the record can segment by the policy that produced each signal',
    /flagged_policy/.test(APP), 'app.html must be able to separate v9 signals from legacy ones');

  done();
})();
