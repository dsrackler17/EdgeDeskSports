#!/usr/bin/env node
/* ===========================================================================
   VERDICT AUTHORITY.

   capture-v9 decides whether a MARKET signal is actionable. The frontend does
   not get a vote. Before this, it had two:

     eqsCompute()          scored CLV history, anchor, books, edge and movement,
                           and emitted BET / WATCH / PASS.
     EDAI.evidence()       scored curEdge, trusted book, book count and has_sharp,
                           and emitted BET / LEAN / WAIT / PASS.

   Neither consulted capture. Today's Desk read the first, the Top 10 read the
   second, and the same selection could therefore read WATCH in one and BET in
   the other at the same instant — which is what was observed on Fresno State
   and Albany.

   THE INVARIANT, and it runs one way only:
     capture decides WHETHER a bet is permitted.
     EQS decides only whether to talk you OUT of one capture already permitted.

   The seven cases below are the ones that matter. Case 6 is the important one:
   an EQS score of 100 and a decision of BET cannot promote a row capture
   refused.

   Run: node tools/capture/verdict_authority.test.js
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
  failures.forEach((f) => console.log('FAIL | ' + f.name
    + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');
const CAPTURE = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'capture', 'index.ts'), 'utf8');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'supabase', 'capture_v9_qualification.sql'), 'utf8');

function slice(src, start, end, label) {
  const a = src.indexOf(start);
  if (a < 0) throw new Error('could not find the start of ' + label);
  const b = src.indexOf(end, a);
  if (b < 0) throw new Error('could not find the end of ' + label);
  return src.slice(a, b + end.length);
}

/* The real predicate + verdict block, run out of the real app.html. */
const BLOCK = slice(APP,
  'function wasFlaggedSignal(e){',
  ": 'Capture qualified it on a robust multi-book consensus, with no sharp reference available.';\n}",
  'the predicate + verdict block');
const EDBOOL = slice(APP, 'function edBool(v){', "v==='t'; }", 'edBool');
const ctx = { console: console, QUAL_REASON_TEXT: { best_price_stale: 'the best price has gone stale' } };
vm.createContext(ctx);
vm.runInContext(EDBOOL + '\n' + BLOCK + '\nthis.__V = canonicalMarketVerdict;', ctx);
const V = ctx.__V;

/* A row as the live board actually receives it. */
function row(over) {
  return Object.assign({
    event_id: 'e1', sport_title: 'NCAAF', sport_key: 'americanfootball_ncaaf',
    market: 'spreads', selection: 'Fresno State', point: -3.5,
    best_dec: 1.95, edge: 0.03, n_books: 6, last_seen_at: new Date().toISOString(),
    flagged_at: '2026-09-05T10:00:00Z', flagged_best_dec: 1.95, flagged_edge: 0.03,
    flagged_policy: 'qual-2026.09.1', flagged_tier: 'A',
    actionable: true, qual_reason: 'ok', qual_tier: 'A', reference_type: 'sharp',
    quality_score: 74, fresh_books: 6,
  }, over || {});
}
const eqs = (d, score) => ({ decision: d, score: score == null ? 70 : score });

/* ═══ THE SEVEN CASES ═════════════════════════════════════════════════════ */

/* 1 — a big edge on a row capture refused for being under its segment floor.
   The +12% is the LIVE edge; capture measured the qualifying edge against a
   fresh reference and said no. The frontend does not get to overrule that. */
{
  const r = row({ edge: 0.12, actionable: false, qual_reason: 'below_segment_edge_floor' });
  chk('1 · +12% edge, flagged, but below the segment floor is never BET', V(r) === 'PASS', V(r));
  chk('1 · and no EQS decision can change that',
    V(r, eqs('BET', 100)) === 'PASS' && V(r, eqs('WATCH')) === 'PASS', [V(r, eqs('BET', 100))]);
}

/* 2 — the price capture would have acted on has gone stale. */
{
  const r = row({ edge: 0.10, actionable: false, qual_reason: 'best_price_stale' });
  chk('2 · a stale best price is PASS, never BET', V(r) === 'PASS', V(r));
  chk('2 · EQS cannot resurrect it', V(r, eqs('BET', 99)) === 'PASS');
}

/* 3 — seen once, holding, not yet confirmed. A real state with its own answer:
   calling it PASS would hide a candidate one capture cycle from qualifying. */
{
  const r = row({ actionable: false, qual_reason: 'awaiting_confirmation', qual_tier: 'B' });
  chk('3 · awaiting_confirmation is WATCH', V(r) === 'WATCH', V(r));
  chk('3 · WATCH regardless of what EQS thinks',
    V(r, eqs('BET', 100)) === 'WATCH' && V(r, eqs('PASS', 0)) === 'WATCH');
}

/* 4 — capture allowed it, tier A, EQS agrees. */
{
  const r = row();
  chk('4 · actionable tier A with EQS BET is BET', V(r, eqs('BET')) === 'BET', V(r, eqs('BET')));
  chk('4 · and BET with no EQS opinion at all, since capture is the authority',
    V(r) === 'BET', V(r));
}

/* 5 — capture allowed it; the research record argues against it. EQS DOWNGRADES.
   This is the direction that is allowed, and it must actually work. */
{
  const r = row();
  chk('5 · EQS PASS downgrades an actionable tier-A row', V(r, eqs('PASS', 10)) === 'PASS', V(r, eqs('PASS', 10)));
  chk('5 · EQS WATCH downgrades it to WATCH', V(r, eqs('WATCH', 50)) === 'WATCH');
}

/* 6 — THE ONE THAT MATTERS. Perfect EQS score, EQS says BET, capture refused
   for insufficient fresh books. EQS cannot upgrade. */
{
  const r = row({ actionable: false, qual_reason: 'insufficient_fresh_books', fresh_books: 2 });
  chk('6 · EQS score 100 + EQS BET cannot promote a row capture refused',
    V(r, eqs('BET', 100)) === 'PASS', V(r, eqs('BET', 100)));
}

/* 7 — a historically flagged row from an older policy with strong CLV. Its
   frozen anchor is intact and the Record still grades it. It is not live. */
{
  const legacy = row({
    actionable: null, qual_reason: null, qual_tier: null,
    flagged_policy: 'pre-v9-legacy', flagged_tier: null, edge: 0.08,
  });
  chk('7 · a legacy flagged row is not actionable on the live board', V(legacy) === 'PASS', V(legacy));
  chk('7 · not even with a strong EQS read', V(legacy, eqs('BET', 95)) === 'PASS');
  chk('7 · but its frozen anchor is untouched, so the Record still has it',
    ctx.wasFlaggedSignal(legacy) === true && legacy.flagged_best_dec === 1.95);
  chk('7 · and the app can tell the two apart',
    ctx.wasFlaggedSignal(legacy) === true && ctx.isActionableSignal(legacy) === false);
  chk('7 · a row with no v9 state is identified as such rather than guessed at',
    ctx.hasQualState(legacy) === false);
}

/* ═══ THE PREDICATES THEMSELVES ═══════════════════════════════════════════ */
{
  chk('actionable requires BOTH fields — a drift between them fails closed',
    ctx.isActionableSignal({ actionable: true, qual_reason: 'below_segment_edge_floor' }) === false
    && ctx.isActionableSignal({ actionable: false, qual_reason: 'ok' }) === false
    && ctx.isActionableSignal({ actionable: true, qual_reason: 'ok' }) === true);

  /* PostgREST returns real booleans, but a verdict gate is the last place to
     assume the transport. Both representations must behave identically. */
  chk('a string "true" is honoured the same as a boolean',
    ctx.isActionableSignal({ actionable: 'true', qual_reason: 'ok' }) === true);
  chk('a string "false" is not actionable',
    ctx.isActionableSignal({ actionable: 'false', qual_reason: 'ok' }) === false);
  chk('an absent actionable is not actionable',
    ctx.isActionableSignal({ qual_reason: 'ok' }) === false);
  chk('and both representations reach the same verdict',
    V(row({ actionable: 'true' })) === V(row({ actionable: true })));

  chk('the HISTORICAL predicate reads the frozen anchor and nothing else',
    ctx.wasFlaggedSignal({ flagged_at: 'x', flagged_best_dec: 1.9 }) === true
    && ctx.wasFlaggedSignal({ actionable: true, qual_reason: 'ok' }) === false);
  chk('isFlaggedSignal still means HISTORICAL, so existing record callers are unchanged',
    ctx.isFlaggedSignal({ flagged_at: 'x', flagged_best_dec: 1.9 }) === true
    && ctx.isFlaggedSignal({ actionable: true, qual_reason: 'ok' }) === false);
  chk('onlyActionable and onlyFlagged select different populations',
    ctx.onlyActionable([row(), row({ actionable: false, qual_reason: 'best_price_stale' })]).length === 1
    && ctx.onlyFlagged([row(), row({ actionable: false, qual_reason: 'best_price_stale' })]).length === 2);

  chk('an unknown tier on an actionable row is PASS, not a guess',
    V(row({ qual_tier: null })) === 'PASS' && V(row({ qual_tier: 'Z' })) === 'PASS');
  chk('tier B leads as LEAN, never BET', V(row({ qual_tier: 'B' })) === 'LEAN');
  chk('a null row is PASS', V(null) === 'PASS');
}

/* ═══ NO SURFACE MAY DERIVE ACTIONABILITY ON ITS OWN ══════════════════════ */
{
  /* EQS is clamped at the source too, so even a surface that reads its decision
     field directly cannot be handed a BET on a refused row. */
  const eqsSrc = slice(APP, 'var captureOk=(typeof isActionableSignal', 'decision=\'PASS\';', 'the EQS clamp');
  chk('eqsCompute clamps its own decision against capture',
    /if\(!captureOk&&decision==='BET'\)/.test(eqsSrc), eqsSrc.slice(0, 300));
  chk('and the clamp sends awaiting_confirmation to WATCH, not PASS',
    /awaiting\?'WATCH':'PASS'/.test(eqsSrc));

  /* The decision-card engine that fed the Top 10. */
  const ev = slice(APP, 'var _capOk=(typeof isActionableSignal', "why='No fair price available", 'the evidence() gate');
  chk('EDAI.evidence() refuses before it scores anything',
    /if\(!_capOk\)\{[\s\S]*verdict='PASS'/.test(ev), ev.slice(0, 400));
  chk('and it routes awaiting_confirmation to WAIT rather than PASS',
    /awaiting_confirmation'\)\{\s*verdict='WAIT'/.test(ev));
  chk('evidence() honours capture\'s tier so a tier-B row cannot reach BET',
    /e\.qual_tier==='B'\)\{ verdict='LEAN'/.test(APP));

  /* Today's Desk. */
  chk('Today\'s Desk derives its decision from the canonical verdict',
    /var cv=canonicalMarketVerdict\(e,q\);/.test(APP)
    && /else if\(cv==='BET'\|\|cv==='LEAN'\)decision='RESEARCH';/.test(APP));
  chk('and no longer reads the EQS decision directly',
    APP.indexOf("else if(q.decision==='BET')decision='RESEARCH';") < 0);

  /* THE TOP 5 IS A RESEARCH LIST AND MUST STILL POPULATE ON A DAY WHEN NOTHING
     QUALIFIES — its own copy promises "when the board is efficient these are
     simply the closest-to-fair prices ... shown for research, not as plays", and
     a filter that removes an unqualified row instead of labelling it breaks that
     promise at exactly the moment the list is the only thing left to look at.
     So it is NOT gated on actionability. What makes that safe is that every row
     it renders wears canonicalMarketVerdict(), which cannot say BET for a row
     capture refused. Seeing is not betting; the label is what separates them. */
  chk('the Top 5 keeps its liquidity bars',
    /if\(\(e\.edge\|\|0\)<REAL_FLOOR\)return false;\s*\n\s*if\(\(e\.n_books\|\|0\)<MINBOOKS\)return false;/.test(APP));
  chk('but does NOT drop a row for being unqualified — it labels it instead',
    !/if\(!isActionableSignal\(e\)\)return false;/.test(APP));
  chk('every Top 5 row carries the canonical verdict',
    /var d5v=\(typeof canonicalMarketVerdict==='function'\)\?canonicalMarketVerdict\(e\):'PASS';/.test(APP));
  chk('an unqualified Top 5 row is tagged as not a signal, never as a play',
    /d5v==='WATCH'\?' <span class="suspect">watch/.test(APP)
    && /' <span class="suspect">pass \\u00b7 not a signal<\/span>'/.test(APP));
  chk('and it states the rule that stopped it',
    /canonicalVerdictWhy/.test(APP.slice(APP.indexOf('var d5v='), APP.indexOf('var d5v=') + 900)));

  /* Grep for anything still deriving a BET from raw inputs. */
  const rawBet = (APP.match(/verdict\s*=\s*'BET'/g) || []).length;
  chk('exactly one place in app.html can still assign a raw BET, and it is gated',
    rawBet === 1, rawBet);
}

/* ═══ THE LIVE QUERIES CARRY WHAT THEY NEED ═══════════════════════════════ */
{
  chk('the live filter is CURRENT state, not the frozen anchor',
    /var BOARD_ACTIVE_FILTER='actionable=is\.true&qual_reason=eq\.ok';/.test(APP));
  ['actionable', 'qual_tier', 'qual_reason', 'reference_type', 'quality_score',
   'fresh_books', 'ref_quote_age_s', 'flagged_at', 'flagged_policy', 'flagged_tier',
   'flagged_reference_type'].forEach((f) => {
    chk('live pools fetch ' + f, new RegExp('BOARD_ACTIVE_COLS[\\s\\S]{0,400}' + f).test(APP), f);
  });
  chk('BOARD_FLAG_COLS now resolves to the active column set, so every live pool gets them',
    /var BOARD_FLAG_COLS=BOARD_ACTIVE_COLS;/.test(APP));
  /* ONLY THE BETTABLE BOARD IS GATED. Two definition sites plus exactly one
     query: EDGES. The research pools (D5_POOL, CONS_POOL) are deliberately
     ungated so the terminal still shows the slate on a day when capture
     qualifies nothing — they are safe because their render paths label rather
     than authorise. Gating them made every surface blank at once, which reads
     to a user exactly like a broken board. */
  const liveFilters = (APP.match(/BOARD_ACTIVE_FILTER/g) || []).length;
  chk('BOARD_ACTIVE_FILTER gates the bettable board and nothing else',
    liveFilters === 3, liveFilters);
  chk('the research pool is NOT gated, so the terminal is never blank',
    /THE RESEARCH POOL, AND IT IS DELIBERATELY NOT GATED ON ACTIONABILITY/.test(APP)
    && /var ft=filterTradeable\(pool\|\|\[\]\);/.test(APP));
  chk('CONSENSUS is not gated on the MARKET engine\'s verdict either',
    /window\.CONS_POOL=filterTradeable\(cq\|\|\[\]\)\.keep;/.test(APP));
  chk('but the bettable board still is',
    /ACTIVE BOARD \u2014 CURRENTLY ACTIONABLE signals only|ACTIVE BOARD — CURRENTLY ACTIONABLE signals only/.test(APP));

  /* Historical reads must NOT have been narrowed. */
  chk('the historical flag filter still exists for the Record and movement reads',
    /var BOARD_FLAG_FILTER='flagged_at=not\.is\.null&flagged_best_dec=not\.is\.null';/.test(APP));
  chk('the movement/discovery pool still reads the historical population, so MISSED survives',
    /\+'&'\+BOARD_FLAG_FILTER/.test(APP));
  chk('the Record pool is untouched and still anchored on the flag',
    APP.indexOf("var FLAG_STRICT='flagged_at=not.is.null&flagged_edge=gte.0.005&flagged_edge=lte.0.1';") >= 0);
}

/* ═══ A MISSING COLUMN IS A DEPLOYMENT FAULT, NOT A QUIET SLATE ═══════════ */
{
  chk('the board detects rows that carry no qualification state',
    /if\(EDGES\.length && !EDGES\.some\(hasQualState\)\)/.test(APP));
  chk('a missing-column error is captured rather than swallowed',
    /actionable\|qual_reason\|column\|schema cache\|PGRST/.test(APP));
  chk('and it outranks every other banner state',
    /THE SCHEMA FAULT OUTRANKS EVERY OTHER BANNER STATE/.test(APP)
    && /Qualification state is missing from the database/.test(APP));
  chk('the banner names the fix rather than just the symptom',
    /capture_v9_qualification\.sql/.test(APP));
}

/* ═══ POLICY-SEGMENTED CLV ════════════════════════════════════════════════ */
{
  chk('slice buckets are keyed by the policy that produced the signal',
    /add\('P\|'\+pol\+'\|all',r\);/.test(APP));
  chk('sliceStat looks up the policy of the row it is asked about',
    /var keys=\['P\|'\+pol\+'\|sm\|'/.test(APP));
  chk('it never falls back to another policy\'s history',
    !/keys=\['sm\|'\+e\.sport_title/.test(APP));
  chk('a thin new-policy sample says so instead of borrowing an old n',
    /New policy \\u00b7 collecting evidence/.test(APP));
  chk('legacy rows are labelled, not deleted', /Legacy policy \\u00b7 n/.test(APP));
  chk('the app\'s policy constant matches the one capture stamps',
    (APP.match(/var CAPTURE_POLICY='([^']+)'/) || [])[1]
    === (CAPTURE.match(/export const POLICY_VERSION = "([^"]+)"/) || [])[1],
    [(APP.match(/var CAPTURE_POLICY='([^']+)'/) || [])[1],
     (CAPTURE.match(/export const POLICY_VERSION = "([^"]+)"/) || [])[1]]);
}

/* ═══ CAPTURE ACTUALLY PERSISTS WHAT THE BOARD READS ══════════════════════ */
{
  chk('capture writes signals.actionable on every priced row',
    /actionable: v\.actionable,/.test(CAPTURE));
  chk('the migration adds it to signals, not only to signal_ticks',
    /add column if not exists actionable\s+boolean,/.test(MIGRATION));
  chk('the board index is on actionable, where the live query now looks',
    /create index if not exists signals_actionable_board_idx[\s\S]{0,140}where actionable is true;/.test(MIGRATION));
  chk('and a separate index still serves the historical flag reads',
    /signals_flagged_history_idx[\s\S]{0,140}where flagged_at is not null;/.test(MIGRATION));
  chk('the migration report checks the column the whole board depends on',
    /signals\.actionable exists/.test(MIGRATION));
}

done();
