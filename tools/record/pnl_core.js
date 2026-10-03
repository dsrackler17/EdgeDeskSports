/* ===========================================================================
   THE P&L LEDGER — one row per EdgeDesk recommendation, from the ledgers the
   pipelines already keep. docs/pnl/DESIGN.md

   Nothing here predicts, prices or grades. Every fact on a row is COPIED from
   a ledger written at the time the recommendation was made, and every result
   is COPIED from the job that already settles it:

     player props     football/props/<lg>/<season>/evaluations.jsonl   the frozen BET / LEAN, at its price
                      football/props/<lg>/<season>/results.jsonl       football/props/grade.js settlement
     game decisions   football/cfb_terminal/decisions/<season>/snapshots.jsonl
                                                                        the first snapshot of each class per
                                                                        game (BET / LEAN / WATCH / PASS), at
                                                                        its price (EDDecisionTrack.firstPerClass)
                      …/evaluations.jsonl                               EDDecisionTrack.gradeEvaluation
     model record     record/football/<sport>_<season>.json             the published number, graded at the
                                                                        close. Priced ONLY through its pick's
                                                                        price lock (tools/record/price_lock.js):
                                                                        the quote EdgeDesk stored at or before
                                                                        the number was published, for the exact
                                                                        number graded — at the default stake.
                                                                        Otherwise a result, never a P&L figure.

   The arithmetic is lib/edgedesk_pnl.js (EDPnl.settle): the P&L of a row is
   derived from its own entry price, stake and result, nothing else.

   IDEMPOTENT, AND AUDITABLE
     - A row is keyed by its recommendation_id and appears once, however
       often this runs. Building twice from the same inputs gives the same
       ledger byte for byte (no clock on a row except the ones the sources
       wrote).
     - The RECOMMENDATION half of a row (who, what, which side, which line,
       which price, which stake, which model, when) is frozen the first time
       the ledger holds it. A source that later says something different is
       refused and reported (an integrity alert); the ledger keeps what was
       recommended.
     - The SETTLEMENT half may change only as a correction: a final score or
       a player statistic that was fixed at the source updates the row in
       place — never a second row — and the change is appended to the row's
       `corrections` with what it was, what it became, when and why.
     - A row is never deleted. A recommendation whose source line disappears
       is kept and flagged.

   Pure: no clock, no network, no file. tools/record/pnl_ledger.js supplies them.
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const PNL = require(path.join(ROOT, 'lib', 'edgedesk_pnl.js'));
const PL = require('./price_lock.js');
/* the stake a graded pick risks when its source recorded none (the model's
   published number), frozen on the row together with its price */
const DEFAULT_STAKE = PNL.validStake(PL.CONFIG.default_stake_units) > 0 ? PL.CONFIG.default_stake_units : PNL.DEFAULT_STAKE_UNITS;

const LEDGER_SCHEMA = 'edgedesk_pnl_ledger_v1';
const SUMMARY_SCHEMA = 'edgedesk_pnl_summary_v1';

/* the recommendation half: frozen once written */
const FROZEN = ['source', 'sport', 'league', 'season', 'week', 'event_id', 'home', 'away', 'game_date', 'model_version', 'engine_version',
  'market_group', 'market_type', 'prop_market', 'player_id', 'player_name', 'team', 'opponent', 'position', 'side', 'selection',
  'model_line', 'entry_line', 'price_assumed', 'model_prob', 'model_edge_pct', 'ev_pct', 'rec_class',
  'recommended_at', 'evaluation_mode'];
/* THE PRICE LOCK: the price, its book and capture time, and the stake it
   risks. Frozen like the rest of the recommendation, with one exception: a
   row that has no price may receive one ONCE (a model-record decision whose
   stored pre-decision quote is matched by the price lock), after which it
   never changes. */
const LOCK = ['entry_odds', 'entry_book', 'odds_captured_at', 'stake_units', 'stake_source', 'price_source', 'price_ref'];
/* the settlement half: may change, only as a logged correction */
const SETTLEMENT = ['result', 'result_value', 'final_score', 'closing_line', 'closing_odds', 'clv_points', 'clv_prob_pp', 'beat_close', 'settled_at'];
/* rows from these evaluation modes were never a recommendation that existed at the time */
const NOT_LIVE = ['BACKTEST', 'WALK_FORWARD', 'REPLAY'];

/* ------------------------------------------------------------- helpers */
function num(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function r2(v) { return v == null ? null : Math.round(v * 100) / 100; }
function r4(v) { return v == null ? null : Math.round(v * 10000) / 10000; }
function iso(t) { const v = typeof t === 'number' ? t : Date.parse(t); return Number.isFinite(v) ? new Date(v).toISOString() : null; }
function lineText(v) { if (v == null) return ''; const x = Math.round(v * 10) / 10; return x === 0 ? 'PK' : (x > 0 ? '+' : '') + String(x); }
function same(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-9;
  return JSON.stringify(a) === JSON.stringify(b);
}
function clean(o) { const out = {}; Object.keys(o).forEach((k) => { if (o[k] !== undefined) out[k] = o[k]; }); return out; }

/* prop market words come from the props kernel's own registry, so a market
   added there is a market here with no change to this file */
let EDP = null;
function props() {
  if (!EDP) { global.window = global.window || global; require(path.join(ROOT, 'lib', 'research_core.js')); EDP = require(path.join(ROOT, 'lib', 'edgedesk_props.js')); }
  return EDP;
}
function propMeta(market) {
  const P = props(), m = P.marketOf(market) || null;
  const cat = m ? (P.CATEGORIES.filter((c) => c.key === m.cat)[0] || null) : null;
  return { label: m ? m.label : market, category: m ? m.cat : 'other', category_label: cat ? cat.label : 'Other', yesno: !!(m && m.yesno) };
}
function bookName(k) { if (!k) return null; const P = props(); return (P.bookName && P.bookName(k)) || k; }

/* event names, from the model record (its game ids are the same ids the prop
   and decision ledgers use: nflverse for the NFL, ESPN events for college) */
function eventIndex(records) {
  const ix = {};
  (records || []).forEach((L) => {
    if (!L || !L.games) return;
    Object.keys(L.games).forEach((k) => {
      const e = L.games[k];
      ix[String(e.game_id)] = { home: e.home || null, away: e.away || null, home_code: e.home_code || null, away_code: e.away_code || null, kickoff: e.kickoff || null, week: e.week != null ? e.week : null,
        final_at: e.final && e.final.at ? e.final.at : (e.final ? e.kickoff || null : null) };
    });
  });
  return ix;
}
/* every final EdgeDesk holds, by game id: the model record's, and the CFB
   Lab's (the finals the game-decision grader reads) */
function finalIndex(events, labResults) {
  const out = {};
  Object.keys(events || {}).forEach((id) => { if (events[id].final_at) out[id] = { at: events[id].final_at, source: 'model record' }; });
  (labResults || []).forEach((r) => {
    if (!r || r.status !== 'FINAL' || num(r.final_margin) == null || out[String(r.game_id)]) return;
    out[String(r.game_id)] = { at: r.recorded_at || null, source: 'CFB Lab results' };
  });
  return out;
}

/* ====================================================== PENDING REASONS
   Why a pending row is still pending, as of the build's clock. From the
   settling jobs' own diagnostics (player props: football/props/<lg>/
   settlement.json, written by football/props/grade.js) and the finals
   EdgeDesk holds. Never a guess: a row the build cannot place is UNKNOWN. */
const IN_PLAY_HOURS = 5;        /* kickoff → a final is due */
const STAT_FEED_HOURS = 48;     /* kickoff → the official player box is due */
const SETTLE_GRACE_HOURS = 40;  /* a final → the game-decision grader has run (it waits up to 36 h for a close) */
function pendingReason(row, ctx, now) {
  if (PNL.rowState(row) !== PNL.STATE.PENDING) return null;
  ctx = ctx || {};
  const ko = Date.parse(row.game_date || '');
  if (!Number.isFinite(ko)) return 'MISSING_MAPPING';
  if (now < ko) return 'UPCOMING';
  const hrs = (now - ko) / 3600e3;
  if (row.market_group === 'prop') {
    const S = (ctx.props || {})[row.league] || null;
    const p = S && S.pending ? S.pending[String(row.recommendation_id).replace(/^pp:/, '')] : null;
    if (p) {
      if (p.code === 'MISSING_MAPPING') return 'MISSING_MAPPING';
      if (p.code === 'DATASET_UNAVAILABLE') return 'SETTLEMENT_FAILED';
      if (p.code === 'GAME_NOT_FINAL') return hrs < IN_PLAY_HOURS ? 'IN_PROGRESS' : 'MISSING_FINAL';
      if (p.code === 'STAT_FEED_PENDING') return hrs < STAT_FEED_HOURS ? 'AWAITING_STAT_FEED' : 'MISSING_PLAYER_STAT';
      return 'UNKNOWN';
    }
    if (hrs < IN_PLAY_HOURS) return 'IN_PROGRESS';
    /* the grader has not run since kickoff (or never wrote its status) */
    const checked = S ? Date.parse(S.checked_at || '') : NaN;
    if (!Number.isFinite(checked) || checked < ko) return hrs < IN_PLAY_HOURS + 6 ? 'AWAITING_SETTLEMENT' : 'SETTLEMENT_FAILED';
    /* it ran after kickoff, did not settle the prop and gave no reason */
    return 'SETTLEMENT_FAILED';
  }
  if (hrs < IN_PLAY_HOURS) return 'IN_PROGRESS';
  const fin = (ctx.finals || {})[String(row.event_id)] || null;
  if (!fin) return (ctx.events || {})[String(row.event_id)] ? 'MISSING_FINAL' : 'MISSING_MAPPING';
  const fAt = Date.parse(fin.at || '');
  const since = (now - (Number.isFinite(fAt) ? Math.max(fAt, ko) : ko)) / 3600e3;
  return since < SETTLE_GRACE_HOURS ? 'AWAITING_SETTLEMENT' : 'SETTLEMENT_FAILED';
}
function eventLabel(league, gid, ev, fallback) {
  if (ev && (ev.away_code || ev.away) && (ev.home_code || ev.home)) return (ev.away_code || ev.away) + ' @ ' + (ev.home_code || ev.home);
  const m = /^\d{4}_\d{2}_([A-Z]{2,3})_([A-Z]{2,3})$/.exec(String(gid || ''));
  if (m) return m[1] + ' @ ' + m[2];
  return fallback || String(gid || '');
}

/* ================================================================ ADAPTERS
   Each returns P&L rows (facts only — EDPnl.settle derives the P&L). */

/* ---- player props --------------------------------------------------- */
function latestResults(results) {
  /* results.jsonl is append-only: a CORRECTION row for an evaluation is a
     later row carrying `correction: true`. The latest row per evaluation
     wins; the history is what the P&L corrections log shows. */
  const by = {};
  (results || []).forEach((x) => {
    if (!x || !x.evaluation_id) return;
    const k = x.evaluation_id;
    (by[k] = by[k] || []).push(x);
  });
  Object.keys(by).forEach((k) => { by[k].sort((a, b) => (Date.parse(a.graded_at) || 0) - (Date.parse(b.graded_at) || 0)); });
  return by;
}
/* every correction row in a prop's settlement history, with what it replaced */
function sourceCorrections(hist) {
  const out = [];
  for (let i = 1; i < hist.length; i++) {
    const h = hist[i], p = hist[i - 1];
    if (!h.correction) continue;
    out.push({ at: iso(h.graded_at), reason: h.correction_reason || h.reason || 'official statistic corrected',
      fields: { result: { from: PNL.normResult(p.result), to: PNL.normResult(h.result) }, result_value: { from: p.value != null ? p.value : null, to: h.value != null ? h.value : null } } });
  }
  return out;
}
function seasonOf(t) { const v = Date.parse(t); if (!Number.isFinite(v)) return null; const d = new Date(v); return d.getUTCMonth() <= 1 ? d.getUTCFullYear() - 1 : d.getUTCFullYear(); }
function propSelection(meta, side, line) {
  if (meta.yesno && line === 0.5) return side === 'over' ? 'Yes' : 'No';
  return (side === 'over' ? 'Over ' : side === 'under' ? 'Under ' : '') + (line != null ? line : '');
}
function propRows(league, evals, results, events, file) {
  const res = latestResults(results);
  const out = [];
  (evals || []).forEach((x) => {
    if (!x || x.kind !== 'qualified' || !x.evaluation_id) return;
    if (x.decision !== 'BET' && x.decision !== 'LEAN') return;
    const lg = String(x.league || league || '').toUpperCase();
    const meta = propMeta(x.market);
    const ev = events[String(x.game_id)] || null;
    const hist = res[x.evaluation_id] || [];
    const g = hist.length ? hist[hist.length - 1] : null;
    const clv = g && g.clv && g.clv.available ? g.clv : null;
    const row = {
      recommendation_id: 'pp:' + x.evaluation_id,
      source: 'player_props',
      source_ref: { file: file, id: x.evaluation_id },
      sport: 'football', league: lg, season: num(x.season), week: num(x.week),
      event_id: String(x.game_id), home: ev ? ev.home : null, away: ev ? ev.away : null,
      event_label: eventLabel(lg, x.game_id, ev, x.team && x.opp ? String(x.team) + ' vs ' + String(x.opp) : null),
      game_date: iso(x.kickoff),
      model_version: x.model_version || null, engine_version: null,
      market_group: 'prop', market_type: 'player_prop', prop_market: x.market, prop_label: meta.label, prop_category: meta.category, prop_category_label: meta.category_label,
      player_id: x.player_id != null ? String(x.player_id) : null, player_name: x.player_name || null, team: x.team || null, opponent: x.opp || null, position: x.position || null,
      side: x.side || null, selection: propSelection(meta, x.side, num(x.line)),
      model_line: r2(num(x.model_mean)), entry_line: num(x.line), entry_odds: x.american != null ? x.american : null, entry_book: x.book || null, entry_book_name: bookName(x.book),
      price_assumed: false,
      model_prob: r4(num(x.p_side)), model_edge_pct: r2(num(x.edge_pp)), ev_pct: x.ev != null ? r2(100 * num(x.ev)) : null,
      rec_class: x.decision, confidence: num(x.confidence), stage: x.stage || null,
      stake_units: x.decision === 'BET' ? (num(x.units) != null ? num(x.units) : 0) : 0,
      stake_source: x.decision === 'BET' && num(x.units) > 0 ? 'explicit' : null,
      price_source: x.american != null ? 'decision' : null, price_ref: null,
      recommended_at: iso(x.evaluated_at),
      odds_captured_at: iso(x.quote_captured_at || x.evaluated_at),
      odds_captured_basis: x.quote_captured_at ? 'quote capture' : 'evaluation time (the price was current when EdgeDesk evaluated it)',
      evaluation_mode: 'LIVE',
      result: g ? PNL.normResult(g.result) : 'pending',
      result_value: g && g.value != null ? g.value : null,
      result_detail: g && g.reason ? g.reason : null,
      final_score: null,
      closing_line: clv ? num(clv.close_line) : null,
      closing_odds: clv && clv.close_price != null ? clv.close_price : null,
      clv_points: clv ? num(clv.line_clv) : null,
      clv_prob_pp: clv ? num(clv.prob_clv_pp) : null,
      beat_close: clv && (clv.beat_close === true || clv.beat_close === false) ? clv.beat_close : null,
      settled_at: g ? iso(g.graded_at) : null,
      source_corrections: sourceCorrections(hist)
    };
    out.push(row);
  });
  return out;
}

/* ---- game decisions (BET / LEAN / WATCH / PASS) --------------------- */
let BT = null;
function track() { if (!BT) BT = require(path.join(ROOT, 'lib', 'edgedesk_decision_track.js')); return BT; }
function gameSelection(mt, side, team, line) {
  if (mt === 'total') return (side === 'over' ? 'Over ' : 'Under ') + (line != null ? line : '');
  if (mt === 'moneyline') return (team || side) + ' ML';
  return (team || side) + ' ' + lineText(line);
}
function decisionRows(snaps, evals, events, file) {
  const byId = {};
  (evals || []).forEach((e) => { if (e && e.snapshot_id) byId[e.snapshot_id] = e; });
  const out = [];
  track().firstPerClass(snaps || []).forEach((s) => {
    const q = s.bet_price || s.reference_quote;
    if (!q || !(q.side === 'home' || q.side === 'away' || q.side === 'over' || q.side === 'under') || num(q.line) == null && s.market_type !== 'moneyline') return;
    if (NOT_LIVE.indexOf(String(s.evaluation_mode || 'LIVE').toUpperCase()) >= 0) return;
    const lg = String(s.sport || '').toUpperCase();
    const mt = s.market_type || 'spread';
    const e = byId[s.snapshot_id] || null;
    const team = q.team || (q.side === 'home' ? s.home : q.side === 'away' ? s.away : null);
    const cls = s.decision === 'WAIT' ? 'WATCH' : s.decision;
    const fair = num(s.model_fair_line);
    const ev = events[String(s.game_id)] || null;
    const clv = e ? num(e.clv_points) : null;
    const row = {
      recommendation_id: 'bd:' + s.snapshot_id,
      source: 'bettor_decision',
      source_ref: { file: file, id: s.snapshot_id },
      sport: 'football', league: lg, season: num(s.season) || seasonOf(s.kickoff), week: num(s.week) != null ? num(s.week) : (ev ? ev.week : null),
      event_id: String(s.game_id), home: s.home || null, away: s.away || null, event_label: (s.away || '?') + ' @ ' + (s.home || '?'),
      game_date: iso(s.kickoff),
      model_version: s.model_version || null, engine_version: s.decision_engine_version || null,
      market_group: 'game', market_type: mt, prop_market: null,
      player_id: null, player_name: null, team: team, opponent: q.side === 'home' ? s.away : q.side === 'away' ? s.home : null, position: null,
      side: q.side, selection: gameSelection(mt, q.side, team, num(q.line)),
      model_line: mt === 'spread' && fair != null ? r2(q.side === 'home' ? fair : -fair) : null,
      entry_line: num(q.line), entry_odds: q.odds != null ? q.odds : null, entry_book: q.book || null, entry_book_name: bookName(q.book),
      price_assumed: false,
      model_prob: r4(num(s.probability != null ? s.probability : (s.calibrated_cover_probability != null ? s.calibrated_cover_probability : q.calibrated_cover))),
      model_edge_pct: r2(num(s.edge_pp != null ? s.edge_pp : q.edge_pp)),
      ev_pct: r2(num(s.decision_ev_pct != null ? s.decision_ev_pct : s.calibrated_ev_pct)),
      rec_class: cls, confidence: num(s.decision_confidence != null ? s.decision_confidence : s.confidence_score), stage: s.validation_state || null,
      stake_units: cls === 'BET' ? (num(s.recommended_units) || 0) : 0,
      stake_source: cls === 'BET' && num(s.recommended_units) > 0 ? 'explicit' : null,
      price_source: q.odds != null ? 'decision' : null, price_ref: null,
      recommended_at: iso(s.evaluated_at),
      odds_captured_at: iso(q.captured_at || s.quote_captured_at),
      odds_captured_basis: 'quote capture',
      evaluation_mode: String(s.evaluation_mode || 'LIVE').toUpperCase(),
      result: e && e.result ? PNL.normResult(e.result) : 'pending',
      result_value: null, result_detail: null, final_score: null,
      closing_line: e ? num(e.close_line) : null,
      closing_odds: null,
      clv_points: clv,
      clv_prob_pp: e ? num(e.clv_price_pp) : null,
      beat_close: clv == null || Math.abs(clv) < 1e-9 ? null : clv > 0,
      settled_at: e ? iso(e.graded_at) : null,
      source_corrections: []
    };
    out.push(row);
  });
  return out;
}

/* ---- the football model record --------------------------------------
   A result always; a price only through the pick's price lock. */
/* why a league's model decisions can carry no stored price at all */
const NO_SOURCE = {
  NFL: 'EdgeDesk stores no timestamped sportsbook price for NFL game markets: the nflverse consensus line it reads is a reference, not a price (no book, no capture time)'
};
/** a decision with no stored quote, published before its league's every-game
    quote ledger began (everyFrom: PL.everyGameFrom, per league) */
function beforeCapture(e, lg, everyFrom) {
  if (!everyFrom || !(lg in everyFrom)) return null;
  const at = Date.parse((e.pick && e.pick.at) || ''), from = everyFrom[lg] ? Date.parse(everyFrom[lg]) : null;
  if (!Number.isFinite(at) || (from != null && at >= from)) return null;
  return { status: 'historical_price_unavailable', why: 'before_capture',
    detail: 'published ' + new Date(at).toISOString() + ', before EdgeDesk began storing every ' + lg + ' game\'s sportsbook quotes'
      + (from != null ? ' (' + everyFrom[lg] + ')' : ' (not started yet)') + '; no quote was kept at or before this number, and a later one is never used' };
}
/** the P&L half of one graded model-record selection: its locked price at the
    default stake, or why it has none (price_lookup) */
function modelPricing(e, lg, mt, side, line, bookName, everyFrom) {
  const lock = e.pick && e.pick.price_lock;
  const hasSource = (PL.CONFIG.price_snapshots.sources || []).some((x) => x.league === lg);
  if (!hasSource) return { price_lookup: { status: 'historical_price_unavailable', why: 'no_snapshot_source', detail: NO_SOURCE[lg] || 'EdgeDesk has no stored-quote source for ' + lg + ' game markets' } };
  if (!lock) return { price_lookup: beforeCapture(e, lg, everyFrom) || { status: 'historical_price_unavailable', why: 'no_snapshot', detail: 'EdgeDesk stored no priced quote for this game' } };
  const r = PL.priceFor(lock[mt], { market_type: mt, side: side, line: line });
  if (r.status !== 'locked') return { price_lookup: (r.why === 'no_snapshot' && beforeCapture(e, lg, everyFrom)) || { status: r.status, why: r.why, detail: r.detail } };
  return {
    entry_odds: r.odds, entry_book: r.book, entry_book_name: bookName(r.book), odds_captured_at: r.observed_at,
    odds_captured_basis: 'the quote EdgeDesk stored at or before the number was published (' + r.source + ')',
    stake_units: DEFAULT_STAKE, stake_source: 'default', price_source: 'snapshot',
    price_ref: { source: r.source, quote_id: r.quote_id, event_id: String(e.game_id), market: mt, side: side, line: r.line, book: r.book,
      observed_at: r.observed_at, decided_at: lock.decided_at, locked_at: r.locked_at },
    result_detail: 'graded at the closing number; priced at the quote EdgeDesk stored for that number before the model published it'
  };
}
let FR = null;
function frCore() { if (!FR) FR = require(path.join(__dirname, 'football_record_core.js')); return FR; }
function modelRecordRows(L, file, everyFrom) {
  if (!L || !L.games) return [];
  const C = frCore();
  const sport = String(L.sport || '').toLowerCase(), lg = sport.toUpperCase();
  const out = [];
  Object.keys(L.games).sort().forEach((k) => {
    const e = L.games[k], g = e.grade || {}, p = e.pick || {}, c = e.close || {}, f = e.final;
    if (!f || g.status !== 'GRADED') return;       /* record-only rows enter once graded */
    const code = (s) => (s === 'home' ? (e.home_code || e.home) : (e.away_code || e.away));
    const label = (e.away_code || e.away) + ' @ ' + (e.home_code || e.home);
    const mode = /^git\b/.test(String(e.provenance || '')) ? 'LIVE_RECONSTRUCTED' : 'LIVE';
    const entryMkt = e.entry && e.entry.market ? e.entry.market : null;
    const sameFamily = entryMkt && C.family(entryMkt.source) === C.family(c.source);
    /* the closing price of the graded side, as the record captured it with the
       closing line (football_record_core pricePick: nflverse consensus for the
       NFL, the ESPN book for college) — never an entry price, never assumed */
    const closeOdds = (kind, gr) => { const q = gr && C.pricePick(kind, gr.side, gr.result, c); return q ? q.odds : null; };
    const baseRow = {
      source: 'model_record', source_ref: { file: file, id: String(e.game_id) },
      sport: 'football', league: lg, season: num(e.season), week: num(e.week),
      event_id: String(e.game_id), home: e.home || null, away: e.away || null, event_label: label, game_date: iso(e.kickoff),
      model_version: p.model_version || e.model_version || null, engine_version: null,
      market_group: 'game', prop_market: null, player_id: null, player_name: null, position: null,
      entry_odds: null, entry_book: entryMkt ? entryMkt.book || null : null, entry_book_name: entryMkt ? entryMkt.book || null : null,
      price_assumed: false, model_edge_pct: null, ev_pct: null, rec_class: 'MODEL', confidence: null, stage: null, stake_units: 0,
      stake_source: null, price_source: null, price_ref: null,
      recommended_at: iso(p.at), odds_captured_at: null, odds_captured_basis: 'no price was captured with the model record',
      evaluation_mode: mode, closing_odds: null, final_score: f.away_score + '–' + f.home_score, settled_at: iso(f.at), source_corrections: [],
      result_detail: 'graded at the closing line; the model record never captured a price'
    };
    if (g.spread && g.spread.side && g.spread.result && c.home_line != null) {
      const side = g.spread.side, sl = side === 'home' ? c.home_line : -c.home_line;
      const cv = sameFamily && entryMkt.home_line != null ? C.clvPts('spread', side, entryMkt.home_line, c.home_line) : null;
      out.push(Object.assign({}, baseRow, {
        recommendation_id: 'mr:' + sport + ':' + e.game_id + ':spread', market_type: 'spread', side: side, team: code(side), opponent: code(side === 'home' ? 'away' : 'home'),
        selection: code(side) + ' ' + lineText(sl), model_line: p.home_line != null ? r2(side === 'home' ? p.home_line : -p.home_line) : null,
        entry_line: entryMkt && entryMkt.home_line != null ? r2(side === 'home' ? entryMkt.home_line : -entryMkt.home_line) : null,
        model_prob: null, model_gap_points: num(g.spread.gap),
        result: g.spread.result, result_value: f.home_score - f.away_score, closing_line: r2(sl), closing_odds: closeOdds('spread', g.spread),
        clv_points: cv, clv_prob_pp: null, beat_close: cv == null || Math.abs(cv) < 1e-9 ? null : cv > 0
      }, modelPricing(e, lg, 'spread', side, r2(sl), bookName, everyFrom)));
    }
    if (g.total && g.total.side && g.total.result && c.total != null) {
      const side = g.total.side;
      const cv = sameFamily && entryMkt.total != null ? C.clvPts('total', side, entryMkt.total, c.total) : null;
      out.push(Object.assign({}, baseRow, {
        recommendation_id: 'mr:' + sport + ':' + e.game_id + ':total', market_type: 'total', side: side, team: null, opponent: null,
        selection: (side === 'over' ? 'Over ' : 'Under ') + c.total, model_line: num(p.total), entry_line: entryMkt ? num(entryMkt.total) : null,
        model_prob: null, model_gap_points: num(g.total.gap),
        result: g.total.result, result_value: f.home_score + f.away_score, closing_line: c.total, closing_odds: closeOdds('total', g.total),
        clv_points: cv, clv_prob_pp: null, beat_close: cv == null || Math.abs(cv) < 1e-9 ? null : cv > 0
      }, modelPricing(e, lg, 'total', side, num(c.total), bookName, everyFrom)));
    }
    if (g.su && g.su.side && g.su.result) {
      const side = g.su.side, wp = num(p.home_win_prob);
      out.push(Object.assign({}, baseRow, {
        recommendation_id: 'mr:' + sport + ':' + e.game_id + ':moneyline', market_type: 'moneyline', side: side, team: code(side), opponent: code(side === 'home' ? 'away' : 'home'),
        selection: code(side) + ' ML', model_line: null, entry_line: null,
        model_prob: wp != null ? r4(side === 'home' ? wp : 1 - wp) : null, model_gap_points: null,
        result: g.su.result, result_value: f.home_score - f.away_score, closing_line: null, closing_odds: closeOdds('ml', g.su),
        clv_points: null, clv_prob_pp: null, beat_close: null
      }, modelPricing(e, lg, 'moneyline', side, null, bookName, everyFrom)));
    }
  });
  return out;
}

/* ================================================================== MERGE
   prev: the ledger as committed (or null); fresh: rows built from the
   sources now; now: the run's clock (stamped only on NEW facts: a first
   appearance or a correction). Returns { ledger, report }. */
function merge(prev, fresh, now) {
  const at = iso(now);
  const old = {};
  ((prev && prev.rows) || []).forEach((x) => { old[x.recommendation_id] = x; });
  const seen = {};
  const report = { added: 0, settled: 0, corrected: 0, unchanged: 0, kept_missing_source: 0, integrity_alerts: [], duplicates_in_sources: 0, price_locked: 0, lock_kept: 0 };
  const rows = [];
  fresh.forEach((f) => {
    if (seen[f.recommendation_id]) { report.duplicates_in_sources++; return; }
    seen[f.recommendation_id] = true;
    const o = old[f.recommendation_id];
    let row;
    if (!o) {
      row = Object.assign({}, f, { first_recorded_at: at, corrections: [], corrected: false });
      if (f.price_source === 'snapshot') { row.price_locked_at = at; report.price_locked++; }
      if ((f.source_corrections || []).length) { row.corrections = f.source_corrections.map((c) => ({ at: c.at, fields: c.fields, reason: c.reason, origin: 'source' })); row.corrected = true; }
      report.added++;
    } else {
      row = Object.assign({}, o);
      /* the recommendation half: never rewritten */
      FROZEN.forEach((k) => {
        if (!same(o[k], f[k])) {
          if (o[k] == null && f[k] != null && (k === 'week' || k === 'season' || k === 'home' || k === 'away')) { row[k] = f[k]; return; }
          report.integrity_alerts.push({ recommendation_id: f.recommendation_id, field: k, ledger: o[k], source: f[k], action: 'kept the recorded value' });
        }
      });
      /* the price lock: set once on a row that had no price, frozen after */
      const wasPriced = o.entry_odds != null || !!o.price_assumed, nowPriced = f.entry_odds != null || !!f.price_assumed;
      if (!wasPriced && nowPriced) {
        LOCK.forEach((k) => { row[k] = f[k] === undefined ? null : f[k]; });
        row.price_locked_at = at;
        report.price_locked++;
      } else {
        LOCK.forEach((k) => {
          if (same(o[k], f[k])) return;
          if (o[k] === undefined) { row[k] = f[k] === undefined ? null : f[k]; return; }      /* a field this ledger did not keep yet */
          /* a stored-quote lock outlives the quote file it came from */
          if (wasPriced && !nowPriced && o.price_source === 'snapshot') { report.lock_kept++; return; }
          report.integrity_alerts.push({ recommendation_id: f.recommendation_id, field: k, ledger: o[k], source: f[k], action: 'kept the recorded value' });
        });
      }
      /* descriptive fields that are not part of the call may be refreshed */
      ['event_label', 'prop_label', 'prop_category', 'prop_category_label', 'source_ref', 'confidence', 'stage', 'model_gap_points', 'team', 'opponent', 'price_lookup'].forEach((k) => { if (f[k] !== undefined) row[k] = f[k]; });
      /* …and the words about the result, unless they describe a price the row no longer takes from its source */
      if (f.result_detail !== undefined && (row.price_source === f.price_source || row.price_source !== 'snapshot')) row.result_detail = f.result_detail;
      /* the words that go with the price follow the price the row actually holds */
      if (same(row.entry_book, f.entry_book)) ['entry_book_name', 'odds_captured_basis'].forEach((k) => { if (f[k] !== undefined) row[k] = f[k]; });
      if (row.entry_odds != null) delete row.price_lookup;
      /* the settlement half */
      const wasSettled = o.result && o.result !== 'pending';
      const changes = {};
      SETTLEMENT.forEach((k) => {
        if (same(o[k], f[k])) return;
        if (f[k] == null && o[k] != null) return;   /* a source that forgot a value never erases one */
        changes[k] = { from: o[k] == null ? null : o[k], to: f[k] };
      });
      const keys = Object.keys(changes);
      if (keys.length) {
        const resultMoved = changes.result && wasSettled;
        const materialMoved = wasSettled && keys.some((k) => k !== 'settled_at' && changes[k].from != null);
        keys.forEach((k) => { row[k] = changes[k].to; });
        if (resultMoved || materialMoved) {
          const src = (f.source_corrections || []).slice(-1)[0];
          row.corrections = (o.corrections || []).concat([{ at: at, fields: changes, reason: src && src.reason ? src.reason : 'the source settlement changed', origin: src ? 'source' : 'rebuild' }]);
          row.corrected = true;
          report.corrected++;
        } else if (!wasSettled && f.result && f.result !== 'pending') report.settled++;
        else report.unchanged++;
      } else report.unchanged++;
    }
    delete row.source_corrections;
    rows.push(finish(row));
  });
  /* never delete: a recommendation the sources no longer carry stays */
  Object.keys(old).forEach((id) => {
    if (seen[id]) return;
    const o = Object.assign({}, old[id], { source_missing: true });
    report.kept_missing_source++;
    rows.push(finish(o));
  });
  rows.sort((a, b) => (Date.parse(a.game_date) || 0) - (Date.parse(b.game_date) || 0) || (a.recommendation_id < b.recommendation_id ? -1 : 1));
  return { rows, report };
}
/* derive the P&L half from the row's own facts */
function finish(row) {
  const s = PNL.settle(row);
  return clean(s);
}

/* ================================================================ SUMMARY
   Everything the Record's P&L section prints, precomputed so the page
   renders it without recomputing the ledger. */
/* the sections themselves live in the kernel (EDPnl.view / breakdowns), shared with the page */
const SCOPES = PNL.SCOPES;
const isBet = PNL.isBet;
const MARKET_LABEL = PNL.MARKET_LABEL, GRADE_LABEL = PNL.GRADE_LABEL;
function breakdowns(rows, mode) { return PNL.breakdowns(rows, mode); }
function view(rows, mode, withBreakdowns) { return PNL.view(rows, mode, withBreakdowns); }
function summarize(ledger, meta) {
  const rows = ledger.rows || [];
  const views = {};
  PNL.SCOPE_ORDER.forEach((k) => {
    const sub = PNL.scopeRows(rows, k);
    views[k] = { label: SCOPES[k].label, flat: view(sub, 'flat', k === 'all'), staked: view(sub, 'staked', k === 'all'), data_quality: PNL.dataQuality(sub) };
  });
  const versions = Array.from(new Set(rows.map((x) => x.model_version).filter(Boolean))).sort();
  const books = Array.from(new Set(rows.filter((x) => x.entry_odds != null).map((x) => x.entry_book_name || x.entry_book).filter(Boolean))).sort();
  /* the graded record (model picks + BETs; leans are the reader's choice on
     the page), every row's one state, why the pending rows are pending, and
     the agreement checks of every scope — from the same rows as the views */
  const rec = rows.filter((x) => PNL.inRecord(x, false));
  const integrity = {};
  PNL.SCOPE_ORDER.forEach((k) => {
    const sub = PNL.scopeRows(rows, k);
    [['flat', false], ['staked', false], ['flat', true]].forEach((m) => {
      const I = PNL.integrity(sub, m[0], m[1]);
      integrity[k + '|' + m[0] + (m[1] ? '+leans' : '')] = { ok: I.ok, n: I.n, failed: I.failed };
    });
  });
  /* VERIFIED P&L: the card of every scope and strategy, and the proof that
     graded = priced + record only */
  const verified = { what: PNL.HELP.verified, default_stake_units: DEFAULT_STAKE, views: {} };
  PNL.SCOPE_ORDER.forEach((k) => {
    const sub = PNL.scopeRows(rows, k);
    verified.views[k] = { staked: PNL.verifiedCard(sub, 'staked'), flat: PNL.verifiedCard(sub, 'flat') };
  });
  const allCard = verified.views.all.staked;
  verified.reconcile = { graded: allCard.graded, priced: allCard.priced, record_only: allCard.record_only, ok: allCard.graded === allCard.priced + allCard.record_only };
  const audit = PNL.auditRows(rows);
  verified.audit = { errors: audit.length, by_check: audit.reduce((a, x) => { a[x.check] = (a[x.check] || 0) + 1; return a; }, {}), first: audit.slice(0, 20) };
  verified.price_lookup = rows.filter((x) => x.source === 'model_record' && PNL.rowState(x) === 'RECORD_ONLY').reduce((a, x) => {
    const w = (x.price_lookup && x.price_lookup.why) || 'unknown'; a[w] = (a[w] || 0) + 1; return a; }, {});
  /* where the stored prices begin (first captures only: stable from run to run) */
  if (meta && meta.prices) {
    verified.price_sources = {
      every_game_from: meta.prices.every_game_from,
      what: 'every_game_from: per league, the first quote of the ledger that stores every game the model prices — the earliest point from which every model decision of that league can be verified. Player props and BET decisions carry the price captured with the decision itself.',
      sources: (meta.prices.coverage || []).map((c) => ({ key: c.key, league: c.league, covers: c.covers, first_capture: c.first_capture }))
    };
  }
  return {
    schema: SUMMARY_SCHEMA, engine: PNL.VERSION, generated_at: meta && meta.generated_at ? meta.generated_at : null,
    season: ledger.season, strategy: 'Verified P&L: every graded EdgeDesk decision — the model\'s published number on a game and every BET — that settled at a real price EdgeDesk captured at or before the decision. Recorded stakes: the units the decision recorded, or the default ' + DEFAULT_STAKE.toFixed(2) + 'u when it recorded none. Flat: 1.00u each. Never mixed.',
    rules: [
      'NO PRICE = NO VERIFIED P&L. A decision is in Verified P&L only when it settled (win, loss or push) at a valid American price that existed at or before the decision. Everything else is in the record only, with its reason.',
      'Historical P&L uses the decision and the price that existed at the time; nothing is re-predicted or re-priced, a closing price is never used as an entry price, and EdgeDesk never assumes −110.',
      'A model-record decision is priced only from a quote EdgeDesk stored at or before the number was published, for the exact number it was graded at; that price and the default stake are then frozen.',
      'A price the source assumed rather than captured is simulated and never counted as verified P&L.',
      'ROI = net profit ÷ total risked × 100. A push or a void returns the stake: it adds nothing to risked or to P&L.',
      'Each recommendation is one row, keyed by its recommendation id. A corrected result updates that row and is logged on it; nothing is deleted.'
    ],
    counts: { rows: rows.length, bets: rows.filter(isBet).length, verified_bets: rows.filter((x) => isBet(x) && x.pnl_status === 'VERIFIED').length,
      priced_decisions: allCard.priced, graded_decisions: allCard.graded, record_only_decisions: allCard.record_only, corrected: rows.filter((x) => x.corrected).length },
    verified: verified,
    model_versions: versions, books: books,
    states: PNL.states(rows),
    pending_reasons: PNL.pendingReasons(rows),
    record: { what: 'Every graded model pick and BET, priced or not, as wins, losses and pushes. Never units.', all: PNL.gradedRecord(rec), by: PNL.recordBreakdowns(rec) },
    integrity: { ok: Object.keys(integrity).every((k) => integrity[k].ok), checks: integrity },
    settlement: (meta && meta.settlement) || null,
    views: views,
    excluded_sources: (meta && meta.excluded_sources) || [],
    integrity_alerts: (meta && meta.integrity_alerts) || [],
    help: PNL.HELP
  };
}

/* ============================================================ PAGE ROWS
   The page's copy of the ledger: the same rows, columnar (every field name
   once), without the audit-only fields. The full ledger stays the record. */
const PAGE_SCHEMA = 'edgedesk_pnl_rows_v1';
const PAGE_COLS = ['recommendation_id', 'source', 'league', 'season', 'week', 'event_id', 'event_label', 'game_date', 'model_version', 'engine_version',
  'market_group', 'market_type', 'prop_market', 'prop_label', 'prop_category_label', 'player_id', 'player_name', 'team', 'opponent', 'position',
  'side', 'selection', 'model_line', 'entry_line', 'entry_odds', 'entry_book', 'entry_book_name', 'price_assumed', 'model_prob', 'model_edge_pct', 'ev_pct',
  'model_gap_points', 'rec_class', 'confidence', 'stake_units', 'recommended_at', 'odds_captured_at', 'evaluation_mode',
  'result', 'result_value', 'final_score', 'closing_line', 'closing_odds', 'clv_points', 'clv_prob_pp', 'beat_close', 'settled_at',
  'corrected', 'corrections', 'source_missing', 'implied_prob', 'flat_profit_units', 'profit_units', 'pnl_status', 'missing_entry_odds',
  'record_state', 'state_reason', 'pending_reason', 'stake_source', 'price_source', 'pnl_exclusion_reason', 'price_why'];
function pageRows(ledger) {
  const ci = PAGE_COLS.indexOf('corrections'), si = PAGE_COLS.indexOf('state_reason'), sti = PAGE_COLS.indexOf('record_state');
  return {
    schema: PAGE_SCHEMA, season: ledger.season, generated_at: ledger.generated_at, cols: PAGE_COLS,
    rows: (ledger.rows || []).map((x) => {
      const r = PAGE_COLS.map((k) => (k === 'price_why' ? (x.price_lookup && x.price_lookup.why) || null : x[k] === undefined ? null : x[k]));
      if (Array.isArray(r[ci]) && !r[ci].length) r[ci] = null;
      /* the page words every state but INVALID itself; only an invalid row's reason rides along */
      if (r[sti] !== 'INVALID') r[si] = null;
      return r;
    })
  };
}
/* the page's inverse (lib/edgedesk_pnl_ui.js carries the same few lines) */
function expandRows(page) {
  const c = (page && page.cols) || [];
  return ((page && page.rows) || []).map((a) => { const o = {}; c.forEach((k, i) => { o[k] = a[i]; }); return o; });
}

module.exports = {
  PAGE_SCHEMA, PAGE_COLS, pageRows, expandRows,
  LEDGER_SCHEMA, SUMMARY_SCHEMA, FROZEN, SETTLEMENT, SCOPES, GRADE_LABEL, MARKET_LABEL,
  propRows, decisionRows, modelRecordRows, modelPricing, LOCK, DEFAULT_STAKE, eventIndex, finalIndex, pendingReason, IN_PLAY_HOURS, STAT_FEED_HOURS, SETTLE_GRACE_HOURS,
  latestResults, merge, finish, summarize, breakdowns, view, isBet, propMeta
};
